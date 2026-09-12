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
  + 'action="grants" to see the mapped paths you hold and the ones you opened. Every granted area gets a '
  + 'name — the `as` you gave it, or the path\'s last segment — and that name IS the path the other side '
  + 'uses: files and directories live in a per-SESSION buffer namespace rooted at / (the areas of all your '
  + 'live grants merge under one root, so a name taken once cannot be reused), and action="ls" with no path '
  + '(or "/") lists the roots. read / edit / download / upload all take buffer paths: /name for an area '
  + 'mapped from a file, /name/sub/file for one mapped from a directory; '
  + 'there is no other addressing, and paths outside the mapped areas are refused. Mind the direction: the '
  + 'HOLDER of a grant acts inside the other side\'s world, so to hand a file over you grant read and ask '
  + 'the other side to download it, while receiving one requires the other side to grant you write. '
  + 'read pages text (offset is a 1-based line, limit caps lines); edit replaces old_string with '
  + 'new_string in place (edit edits existing files; new files arrive by upload). download and upload are the explicit byte moves '
  + 'between the two machines: download copies a buffer file to dest in your own world, upload pushes '
  + 'your src file into the buffer at path. Files up to 32 MiB move inline; anything larger is relayed '
  + 'in 16 MiB chunks with sha256 verification automatically, up to 4 GiB — no special action is needed.'
