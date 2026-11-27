export function greet(name, options = {}) {
  const text = `Hello, ${name}!`;
  if (options.shout) {
    return text.toUpperCase();
  }
  return text;
}
