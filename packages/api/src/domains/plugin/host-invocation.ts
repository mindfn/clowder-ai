/**
 * F202 — the Host→plugin direction, as one mechanism rather than one per feature.
 *
 * Everything the Host initiates against a package reduces to the same three things: who to call,
 * which method that package declared, and what to hand it. Outbound message delivery is the first
 * consumer, but it carries no privileged status here — a schedule firing, a webhook arriving, or
 * any later reason the Host has to call into a package is the same call with a different declared
 * method. Adding a second bespoke path for the next one is the mistake this module exists to
 * prevent.
 *
 * DECLARATION, NOT DISCOVERY. The method name is never guessed: a package declares it in its
 * contribution (`CallbackAction.method`), and the Host calls exactly what was declared. That keeps
 * the Host from knowing anything about what kind of package it is talking to.
 *
 * CARRIERS. An in-process module carrier makes this a function call — the TypeScript shape of the
 * SPI the operator described. An external stdio carrier makes it a reverse frame on the connection
 * that already exists. Both satisfy the same contract, so a consumer never branches on carrier.
 *
 * REJECTION IS LOAD-BEARING. A rejected call must reject here. Callers use that signal to decide
 * whether work was accepted — the delivery driver, for one, holds its cursor still on rejection so
 * the work comes back rather than being lost — so a carrier must never swallow a failure and
 * report success.
 */
export interface HostInvocationPort {
  /**
   * Call a method the target declared.
   *
   * @param targetId  the package instance to call
   * @param method    the method name it declared, never one the Host invented
   * @param params    the payload for that method
   */
  invoke(targetId: string, method: string, params: unknown): Promise<void>;
}
