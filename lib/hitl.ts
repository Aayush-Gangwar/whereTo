/**
 * When should the client automatically send the conversation back to the server?
 *
 * Only right after the human answered the in-chat form (ask_user_preferences): that tool has no server executor, so the
 * run is paused until the browser supplies its result. The rule is that the FORM is the last part of the newest
 * assistant message and has an answer. As soon as the resumed run appends anything after it, the rule is false again,
 * so it can never loop.
 *
 * The AI SDK's own lastAssistantMessageIsCompleteWithToolCalls is not safe here: it is true for any final step whose
 * tool calls all have outputs, which is exactly what a finished run with server-executed tools looks like.
 */
export function shouldResumeAfterHuman({ messages }: { messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<any> }> }): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  const part = last.parts.at(-1);
  return part?.type === "tool-ask_user_preferences" && part.state === "output-available";
}
