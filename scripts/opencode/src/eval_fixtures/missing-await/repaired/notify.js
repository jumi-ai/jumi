export async function notifyAll(users, send) {
  await Promise.all(users.map((user) => send(user)));
}
