/**
 * Which group a session belongs to in the list.
 *
 * Sessions are gathered by the checkout they are working in, because that is how a person
 * thinks of them when they have not said otherwise. A session they *have* named stands on
 * its own: naming one is how they pick it out, and folded into a group its name would show
 * only if the group happened to choose it to title itself with, and otherwise not until
 * the group was opened.
 *
 * Its own file, with nothing imported, so it can be tested as the rule it is.
 */
export const sessionGroupKey = (session: {
  conversationId: string;
  workspacePath: string | null;
  displayName: string | null;
}): string => {
  if (session.displayName) return `named:${session.conversationId}`;
  return session.workspacePath ? `cwd:${session.workspacePath}` : `session:${session.conversationId}`;
};
