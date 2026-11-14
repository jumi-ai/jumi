#!/usr/bin/env python3
"""Landlock wrapper confining one review-spawn agent process (jumi#531).

The harness spawns the agent through this wrapper instead of directly. The
wrapper builds a Landlock ruleset (read-write: checkout and scratch,
read-only: toolchains and system paths, everything else denied), restricts
itself (no_new_privs + restrict_self), and execs the agent. Every command the
model then runs (tests, scripts, package installs) inherits the domain, so
pull code sees only the checkout and scratch space.

Filesystem allow-list only: Landlock has no deny rules, so anything not
listed is denied. Environment scrubbing stays in the harness
(`src/review_sandbox.ts` audits the child env before spawn); network is
inherited from the pod (the NetworkPolicy keeps doing hosts).

Exit codes: 100 = sandbox unavailable (no Landlock, ABI too old, or a
syscall failed: the harness fails the review closed); 101 = usage error.

Only the stdlib and libc syscalls are used: no new binary to pin, no new
license to review, and `python3` is already in the reviewer image.
"""

import argparse
import ctypes
import os
import sys

MIN_ABI = 6
SANDBOX_UNAVAILABLE_EXIT = 100
USAGE_EXIT = 101

LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

# Stable UAPI bit numbers (linux/landlock.h). Requested as an exact mask:
# an EINVAL here fails closed rather than silently running weakened.
ACCESS_FS_EXECUTE = 1 << 0
ACCESS_FS_WRITE_FILE = 1 << 1
ACCESS_FS_READ_FILE = 1 << 2
ACCESS_FS_READ_DIR = 1 << 3
ACCESS_FS_REMOVE_DIR = 1 << 4
ACCESS_FS_REMOVE_FILE = 1 << 5
ACCESS_FS_MAKE_CHAR = 1 << 6
ACCESS_FS_MAKE_DIR = 1 << 7
ACCESS_FS_MAKE_REG = 1 << 8
ACCESS_FS_MAKE_SOCK = 1 << 9
ACCESS_FS_MAKE_FIFO = 1 << 10
ACCESS_FS_MAKE_BLOCK = 1 << 11
ACCESS_FS_MAKE_SYM = 1 << 12
ACCESS_FS_REFER = 1 << 13
ACCESS_FS_TRUNCATE = 1 << 14

ACCESS_SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0
ACCESS_SCOPE_SIGNAL = 1 << 1

RO_ACCESS = ACCESS_FS_EXECUTE | ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR
# /dev needs WRITE_FILE too (tools open /dev/null O_RDWR); creation rights
# stay off, so no new device nodes appear.
DEV_ACCESS = RO_ACCESS | ACCESS_FS_WRITE_FILE
RW_ACCESS = (
    RO_ACCESS
    | ACCESS_FS_WRITE_FILE
    | ACCESS_FS_REMOVE_DIR
    | ACCESS_FS_REMOVE_FILE
    | ACCESS_FS_MAKE_CHAR
    | ACCESS_FS_MAKE_DIR
    | ACCESS_FS_MAKE_REG
    | ACCESS_FS_MAKE_SOCK
    | ACCESS_FS_MAKE_FIFO
    | ACCESS_FS_MAKE_BLOCK
    | ACCESS_FS_MAKE_SYM
    | ACCESS_FS_REFER
    | ACCESS_FS_TRUNCATE
)
HANDLED_FS = RW_ACCESS

# landlock_create_ruleset / landlock_add_rule / landlock_restrict_self.
# x86_64 and aarch64 share this numbering; anything else fails closed.
SYSCALLS = {
    "x86_64": (444, 445, 446),
    "aarch64": (444, 445, 446),
    "arm64": (444, 445, 446),
}


class RulesetAttr(ctypes.Structure):
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("handled_access_scope", ctypes.c_uint64),
    ]


class PathBeneathAttr(ctypes.Structure):
    _fields_ = [
        ("allowed_access", ctypes.c_uint64),
        ("parent_fd", ctypes.c_int32),
    ]


def unavailable(reason: str) -> "NoReturn":
    print(f"review-sandbox: unavailable: {reason}", file=sys.stderr)
    sys.exit(SANDBOX_UNAVAILABLE_EXIT)


def landlock_abi(libc: ctypes.CDLL, numbers: tuple) -> int | None:
    libc.syscall.restype = ctypes.c_long
    libc.syscall.argtypes = None
    ctypes.set_errno(0)
    abi = libc.syscall(numbers[0], None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    if abi < 0:
        return None
    return int(abi)


def build_ruleset(libc: ctypes.CDLL, numbers: tuple, ro: list, dev: list, rw: list) -> int:
    create, add_rule, restrict_self = numbers
    libc.syscall.restype = ctypes.c_long
    libc.syscall.argtypes = None
    attr = RulesetAttr(HANDLED_FS, 0, ACCESS_SCOPE_ABSTRACT_UNIX_SOCKET | ACCESS_SCOPE_SIGNAL)
    ctypes.set_errno(0)
    ruleset = libc.syscall(create, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if ruleset < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset")

    def add(path: str, access: int, required: bool) -> None:
        try:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError as err:
            if required:
                raise OSError(f"required sandbox path missing: {path}: {err}")
            print(f"review-sandbox: skipping absent read-only path: {path}", file=sys.stderr)
            return
        try:
            rule = PathBeneathAttr(access, fd)
            ctypes.set_errno(0)
            rc = libc.syscall(add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0)
            if rc != 0:
                raise OSError(ctypes.get_errno(), f"landlock_add_rule({path})")
        finally:
            os.close(fd)

    for path in ro:
        add(path, RO_ACCESS, required=False)
    for path in dev:
        add(path, DEV_ACCESS, required=False)
    for path in rw:
        add(path, RW_ACCESS, required=True)

    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(NO_NEW_PRIVS)")
    ctypes.set_errno(0)
    if libc.syscall(restrict_self, ruleset, 0) != 0:
        raise OSError(ctypes.get_errno(), "landlock_restrict_self")
    os.close(ruleset)
    return 0


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="Confine one review-spawn agent with Landlock, then exec it.")
    parser.add_argument("--check", action="store_true", help="print the Landlock ABI and exit 0 when it meets MIN_ABI")
    parser.add_argument("--ro", action="append", default=[], help="read-only path (repeatable)")
    parser.add_argument("--dev", action="append", default=[], help="device path: read-only plus /dev/null-style writes (repeatable)")
    parser.add_argument("--rw", action="append", default=[], help="read-write path (repeatable)")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="agent argv after '--'")
    args = parser.parse_args(argv)
    machine = os.uname().machine
    numbers = SYSCALLS.get(machine)
    if numbers is None:
        unavailable(f"unsupported architecture {machine}")
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
    except OSError as err:
        unavailable(f"cannot load libc: {err}")

    abi = landlock_abi(libc, numbers)
    if abi is None:
        unavailable("landlock_create_ruleset failed: kernel has no Landlock")
    if args.check:
        print(f"landlock-abi={abi}")
        if abi < MIN_ABI:
            unavailable(f"Landlock ABI {abi} is below the required {MIN_ABI}")
        return 0
    if abi < MIN_ABI:
        unavailable(f"Landlock ABI {abi} is below the required {MIN_ABI}")

    rest = args.command
    if not rest or rest[0] != "--":
        print("review-sandbox: usage: review_sandbox.py [--ro P]... [--rw P]... -- CMD [ARGS...]", file=sys.stderr)
        return USAGE_EXIT
    command = rest[1:]
    if not command:
        print("review-sandbox: no command after '--'", file=sys.stderr)
        return USAGE_EXIT

    try:
        build_ruleset(libc, numbers, args.ro, args.dev, args.rw)
    except OSError as err:
        unavailable(str(err))
    os.execvp(command[0], command)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
