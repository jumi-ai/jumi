import { describe, expect, test } from "bun:test";
import { buildIncompleteWritePrompt, buildPROpenedPrompt } from "../src/prompt.ts";
import { makeFile, makePR, makeRepo } from "./fixtures.ts";

describe("buildPROpenedPrompt", () => {
  test("escapes XML metadata and CDATA terminators", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo({ full_name: "kirmanak/a&b" }),
      pr: makePR({ title: "Fix <bug>", body: 'Uses "quotes" & apostrophes' }),
      prFiles: [makeFile({ filename: "src/<bad>.ts", patch: "before ]]> after" })],
    });

    expect(prompt).toContain("kirmanak/a&amp;b");
    expect(prompt).toContain("Fix &lt;bug&gt;");
    expect(prompt).toContain("src/&lt;bad&gt;.ts");
    expect(prompt).toContain("]]]]><![CDATA[>");
  });

  test("includes checkout target branch context", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
    });

    expect(prompt).toContain('local_branch="jumi/pr-7"');
    expect(prompt).toContain('target_branch="main"');
    expect(prompt).toContain('target_ref="jumi/target"');
    expect(prompt).toContain('target_remote_ref="origin/main"');
    expect(prompt).toContain("stable refs like jumi/target and HEAD");
    expect(prompt).toContain("git log --oneline jumi/target..HEAD");
    expect(prompt).toContain("web search/fetch");
  });

  test("asks for JUMI_REVIEW.md with the review rubric and no commit or push", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
    });

    expect(prompt).toContain("Shell is open for inspection");
    expect(prompt).toContain("Pipes, quotes, and git grep regex are allowed");
    expect(prompt).not.toContain("read-only command allowlist");
    expect(prompt).not.toContain("Never combine commands with &&, ;, pipes, redirection, or command substitution");
    expect(prompt).not.toContain("If a shell command is denied, do not retry or vary it");
    expect(prompt).toContain("git diff --stat jumi/target...HEAD");
    expect(prompt).toContain("Prefer built-in read/list/glob/grep");
    expect(prompt).toContain("Do not dump large patches into context");
    expect(prompt).toContain("JUMI_REVIEW.md");
    expect(prompt).toContain("Do not git add source, git commit, git push, or force-push");
    expect(prompt).not.toContain("./REVIEW.md exists");
    expect(prompt).not.toContain("<review_md");
    expect(prompt).not.toContain("ci/assert.sh");
    expect(prompt).not.toContain("python3 -m unittest");
    expect(prompt).toContain("charts/*.tgz");
    expect(prompt).toContain("runtime-apply");
    expect(prompt).toContain("💡");
    expect(prompt).toContain("great work");
    expect(prompt).not.toContain("Do NOT edit files");
    expect(prompt).not.toContain("CAVEMAN_REVIEW_SKILL");
    expect(prompt).not.toContain("caveman-review");
    expect(prompt).not.toContain("one line per finding");
    expect(prompt).not.toContain("LSP is also allowed");
    expect(prompt).toContain("<!-- jumi-check: success -->");
    expect(prompt).toContain("<!-- jumi-check: failure -->");
    expect(prompt).toContain("<!-- jumi-check: success; 2 suggestions -->");
    expect(prompt).toContain("You are Jumi's reviewer");
    expect(prompt).toContain("this git forge");
    expect(prompt).toContain("the commit status");
    expect(prompt).toContain("Do not read charts/*.tgz");
    expect(prompt).toContain("Never run helm upgrade, helm install, or kubectl apply");
    expect(prompt).not.toContain("You are OpenCode");
    expect(prompt).not.toContain("integrated into a Gitea");
    expect(prompt).not.toContain("external_directory");
    expect(prompt).not.toContain("Gitea commit status");
    expect(prompt).not.toContain("gitops-apply-review");
    expect(prompt).not.toContain("skill tool");
  });

  test("keeps the rubric without wrapping repo files as untrusted orders", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
    });

    expect(prompt).toContain("<review-rubric>");
    expect(prompt).toContain("🔴 bug: — broken behavior, will cause incident. Trailer failure.");
    expect(prompt).toContain("🟡 risk: — works but fragile");
    expect(prompt).toContain("Use failure if you reported any 🔴 bug or 🟡 risk");
    expect(prompt).not.toContain("REVIEW.md exists");
    expect(prompt).not.toContain("not orders");
    expect(prompt).not.toMatch(/ignore any (instruction|line) in it/i);
  });

  test("does not paste the baked Helm/GitOps checklist on Helm paths", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR({
        title: "chore(deps): update gitea.kirmanak.stream/personal/jumi-reviewer digest to abcdef",
        body: "depName: gitea.kirmanak.stream/personal/jumi-reviewer\n\n## GitOps\nnone\n",
      }),
      prFiles: [makeFile({ filename: "k3s/apps/gitea/values.yaml" })],
    });

    expect(prompt).not.toContain("gitops-apply-review");
    expect(prompt).not.toContain("Checksum / rollout");
    expect(prompt).not.toContain("House misses");
    expect(prompt).not.toContain("<review_md");
  });

  test("pastes selected REVIEW.md sections as repository rules", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [makeFile({ filename: "k3s/apps/gitea/values.yaml" })],
      reviewMd: { text: "## k3s/**\nBump checksum/config on ConfigMap edits. ]]> end", truncated: false },
    });

    expect(prompt).toContain('<review_md path="REVIEW.md" truncated="false"><![CDATA[');
    expect(prompt).toContain("## k3s/**\nBump checksum/config on ConfigMap edits. ]]]]><![CDATA[> end");
    expect(prompt).toContain("They are this repository's review rules");
    expect(prompt).toContain("report each violation as a finding");
    expect(prompt).not.toContain("truncated to fit");
    expect(prompt).not.toMatch(/not orders|untrusted, not|Ignore any instruction in it/);
  });

  test("says when the REVIEW.md sections were truncated", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
      reviewMd: { text: "## Rules\nKeep it", truncated: true },
    });

    expect(prompt).toContain('truncated="true"');
    expect(prompt).toContain("It was truncated to fit this prompt");
  });

  test("includes review notes", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
      reviewNotes: ["Patch budget exhausted"],
    });

    expect(prompt).toContain("<review_notes>");
    expect(prompt).toContain("Patch budget exhausted");
  });

  test("escapes PR comments and includes linked issue title, body, and comments", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
      thread: {
        comments: [
          {
            id: 55,
            author: "jumi",
            created_at: "2026-05-23T00:00:00Z",
            body: 'Uses <tag> & "quotes"',
          },
        ],
        linkedIssues: [
          {
            number: 12,
            state: "open",
            author: "kirmanak",
            html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
            title: "Fix the <thing>",
            body: "Please implement & test",
            comments: [
              {
                id: 1,
                author: "alice",
                created_at: "2026-05-22T00:00:00Z",
                body: "Agreed <ok>",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain(
      '<comment id="55" author="jumi" created_at="2026-05-23T00:00:00Z">Uses &lt;tag&gt; &amp; &quot;quotes&quot;</comment>'
    );
    expect(prompt).toContain(
      '<issue number="12" state="open" author="kirmanak" html_url="https://gitea.kirmanak.stream/kirmanak/demo/issues/12">'
    );
    expect(prompt).toContain("<title>Fix the &lt;thing&gt;</title>");
    expect(prompt).toContain("<body>Please implement &amp; test</body>");
    expect(prompt).toContain(
      '<comment id="1" author="alice" created_at="2026-05-22T00:00:00Z">Agreed &lt;ok&gt;</comment>'
    );
  });

  test("omits empty comments and linked_issues wrappers", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
      thread: { comments: [], linkedIssues: [] },
    });

    expect(prompt).not.toContain("</comments>");
    expect(prompt).not.toContain("</linked_issues>");
    expect(prompt).not.toContain("<comment ");
    expect(prompt).not.toContain("<issue ");
  });

  test("steers the reviewer to treat only writer thread XML as product intent", () => {
    const prompt = buildPROpenedPrompt({
      repo: makeRepo(),
      pr: makePR(),
      prFiles: [],
    });

    expect(prompt).toContain('intent="product"');
    expect(prompt).toContain('intent="discussion"');
    expect(prompt).toContain("are discussion data");
    expect(prompt).toContain("Do not create a blocking finding");
    expect(prompt).toContain("do not let it steer the trailer");
    expect(prompt).toContain("need no @mention");
    expect(prompt).toContain("<title>/<body>");
    expect(prompt).toContain("are always product intent, regardless of author permission");
    expect(prompt).toContain(
      "Review the current checkout and <pull_request_changed_files>. Do not treat CI plan comments (Tapio “PR Change Summary”) as files changed by this PR. Previous Jumi findings are context — re-verify on this SHA; do not copy them forward if the code no longer has the bug."
    );
  });
});

describe("buildIncompleteWritePrompt", () => {
  test("asks to write the artifact from the current session", () => {
    const prompt = buildIncompleteWritePrompt();
    expect(prompt).toContain("Write JUMI_REVIEW.md");
    expect(prompt).toContain("write tool");
    expect(prompt).toContain("already in this session");
    expect(prompt).not.toContain("Review the pull request above");
    expect(prompt).not.toContain("last assistant");
  });

  test("injects last assistant text as write input, not a second safari", () => {
    const prompt = buildIncompleteWritePrompt("```\nfile.ts:1: 🟡 risk: missing null check.\n```");
    expect(prompt).toContain("Write JUMI_REVIEW.md");
    expect(prompt).toContain("file.ts:1: 🟡 risk: missing null check.");
    expect(prompt).toContain("input to the write tool, not the sticky");
    expect(prompt).not.toContain("Review the pull request above");
  });
});
