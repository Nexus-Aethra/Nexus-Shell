/**
 * The one system-prompt section this plugin contributes.
 *
 * A single tool with twelve actions is affordable for the model only if the
 * protocol is also stated in words: when delegation is appropriate, that the
 * answer arrives as a later message rather than a return value, and that a
 * request received here must be settled. The tool description carries the
 * mechanics; this section carries the standing policy that applies whether or
 * not a buffer call is in flight.
 */

/** The prompt text. One paragraph, no interpolation: the state lives in tool output. */
export const BUFFER_PROMPT_TEXT =
  'Some sessions may be connected to this one by a cross-session pipe, which only the user can create. '
  + 'Use the dshell_buffer tool to see those connections and to hand work to a connected session, or to '
  + 'serve work handed to you. Delegation is asynchronous by design: dshell_buffer action="delegate" '
  + 'returns a ticket id immediately and the answer arrives later as a new message that reopens this '
  + 'turn, so do not wait, poll, or sleep on it — end the turn or continue other work. When you delegate, '
  + 'state the request completely (subject, detail, acceptance criteria) because the other session sees '
  + 'only what you send. When a request arrives for you, claim it and drive it to a settlement with '
  + 'action="finish" (a result) or action="fail" (a reason); a request left unsettled is settled as a '
  + 'timeout by the watchdog and reported as a failure, which is worse than an honest failure. A '
  + 'delegation may carry grants — directories of this session opened to the other side, each with read '
  + 'and/or write rights. A grant lives only while its ticket is unsettled, and it is the only way that '
  + 'session can reach this one tree, so open the narrowest areas that let the task be finished. Use '
  + 'action="grants" to see what you hold or have issued, and read / ls / write to exercise a grant you '
  + 'hold; paths outside the granted areas are refused. When a file must actually cross between the two '
  + 'machines — binary, or simply kept byte-for-byte — use action="transfer" instead of read/write: it '
  + 'moves one file between the granted area and your own machine, and with no dest it lands at the same '
  + 'relative path on the other side.'
