export async function notifyAll(users, send) {
  users.forEach((user) => send(user));
}
