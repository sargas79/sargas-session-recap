/**
 * Error reporting for slash-command interactions (THROWAWAY spike). Kept free of discord.js imports so
 * it is testable offline with a fake interaction.
 *
 * A deferred interaction (deferReply) has `deferred === true` and `replied === false`; calling reply()
 * on it throws, so the failure must go through editReply(). Failures while reporting are swallowed and
 * returned, never rethrown, so the command handler cannot produce an unhandled rejection.
 */
export interface ReplyTarget {
  readonly deferred: boolean;
  readonly replied: boolean;
  reply(options: { content: string; flags?: number }): Promise<unknown>;
  editReply(options: { content: string }): Promise<unknown>;
}

export async function reportFailure(i: ReplyTarget, content: string, ephemeralFlag?: number): Promise<"edited" | "replied" | "skipped" | Error> {
  try {
    if (i.replied) return "skipped";
    if (i.deferred) {
      await i.editReply({ content });
      return "edited";
    }
    await i.reply(ephemeralFlag === undefined ? { content } : { content, flags: ephemeralFlag });
    return "replied";
  } catch (e) {
    return e as Error;
  }
}
