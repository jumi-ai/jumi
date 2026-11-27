export function summarize(notes) {
  if (notes.length === 1) {
    return "You have 1 note.";
  }
  return `You have ${notes.length} notes.`;
}
