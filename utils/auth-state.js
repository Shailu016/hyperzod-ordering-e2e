/** Persist fresh credentials without carrying a test's mutated cart into later contexts. */
function authenticatedState(snapshot, liveUser, expectedOrigin) {
  if (liveUser?.isLoggedIn !== true || !liveUser.loggedInUser?.id) throw new Error('Cannot persist an unverified live session');
  if (!snapshot.origins.some((entry) => entry.origin === expectedOrigin)) throw new Error('Authenticated origin is missing');
  return { ...snapshot, origins: snapshot.origins.map((origin) => {
    if (origin.origin !== expectedOrigin) return origin;
    const values = new Map(origin.localStorage.map((entry) => [entry.name, entry.value]));
    if (!values.get('access_token') || !values.get('token_expires_in')) throw new Error('Authenticated credentials are missing');
    const persisted = JSON.parse(values.get('vuex') || '{}');
    // Deferred Vuex persistence can still contain isLoggedIn=false after live authentication succeeds.
    values.set('vuex', JSON.stringify({ ...persisted, User: liveUser }));
    return { ...origin, localStorage: [...values].map(([name, value]) => ({ name, value })) };
  }) };
}
function refreshAuthState(previous, fresh, expectedOrigin) {
  if (!previous.origins.some((entry) => entry.origin === expectedOrigin)) throw new Error('Original authenticated fixture origin is missing');
  return {
    cookies: fresh.cookies,
    origins: previous.origins.map((origin) => {
      if (origin.origin !== expectedOrigin) return origin;
      const current = fresh.origins.find((candidate) => candidate.origin === origin.origin);
      if (!current) throw new Error('Renewed auth origin is missing from storage state');
      const values = new Map(origin.localStorage.map((entry) => [entry.name, entry.value]));
      const latest = new Map(current.localStorage.map((entry) => [entry.name, entry.value]));
      for (const name of ['access_token', 'token_expires_in']) {
        if (!latest.get(name)) throw new Error('Renewed auth state is missing a credential or expiry');
        values.set(name, latest.get(name));
      }
      const baseline = JSON.parse(values.get('vuex') || '{}');
      const active = JSON.parse(latest.get('vuex') || '{}');
      if (!active.User) throw new Error('Renewed user state is missing');
      values.set('vuex', JSON.stringify({ ...baseline, User: active.User }));
      return { origin: origin.origin, localStorage: [...values].map(([name, value]) => ({ name, value })) };
    }),
  };
}
module.exports = { refreshAuthState, authenticatedState };
