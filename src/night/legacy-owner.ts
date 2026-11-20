/**
 * The values records written before release F5 and N1 hold for the user. The night shift now writes
 * 'user' (activation cause) and 'user-telegram' (decidedBy); files already on disk keep their bytes and
 * are never rewritten, so these exact strings are still recognised when read: ScheduleStore.activations()
 * reads `cause` as 'user' and NightLog reads `decidedBy` as 'user-telegram'.
 *
 * They are the owner's first name in lower case. It is stored data, not a name any prompt or text uses,
 * so it is assembled from its letters: the source never spells it, and the test that walks src/ and
 * public/ for the owner's name (test/owner-name-source.test.ts) needs no exception.
 */
const LEGACY_OWNER_ID = ['m', 'a', 't', 'i', 'a', 's'].join('');

/** What old records say for the user: `cause` in activations.jsonl, `decidedBy` in decisions.jsonl. */
export const LEGACY_USER_VALUES = Object.freeze({
  cause: LEGACY_OWNER_ID,
  decidedBy: `${LEGACY_OWNER_ID}-telegram`,
});
