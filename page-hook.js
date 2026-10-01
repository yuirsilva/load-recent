(() => {
  "use strict";

  const COMMAND_EVENT = "instagram-oldest-first:relay-command";
  const PROGRESS_EVENT = "instagram-oldest-first:relay-progress";
  const ENGINE_VERSION = "relay-cache-v3";
  const CACHE_DB_NAME = "instagram-oldest-first-cache";
  const CACHE_STORE_NAME = "profiles";
  const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const CACHE_EXPIRY_SAFETY_MS = 5 * 60 * 1000;
  const CACHE_FALLBACK_AGE_MS = 15 * 60 * 1000;
  const CONNECTION_KEY =
    "PolarisProfilePostsTabContentQuery_connection_xdt_api__v1__feed__user_timeline_graphql_connection";
  const ROOT_FIELD = "xdt_api__v1__feed__user_timeline_graphql_connection";

  const PAGINATION_VARIABLES = new Set(["after", "before", "first", "last", "username"]);
  const DEFAULT_QUERY_VARIABLES = {
    data: {
      count: 12,
      include_reel_media_seen_timestamp: true,
      include_relationship_info: true,
      latest_besties_reel_media: true,
      latest_reel_media: true
    },
    include_multi_captions: false
  };

  let runToken = 0;
  let activeSession = null;
  let observedQueryVariables = null;
  let lastPageResponse = null;

  function rememberQueryVariables(body) {
    try {
      const params = body instanceof URLSearchParams
        ? body
        : typeof body === "string" ? new URLSearchParams(body) : null;
      if (!params) return "";
      const name = params.get("fb_api_req_friendly_name") || "";
      if (!name.startsWith("PolarisProfilePosts")) return "";
      const variables = JSON.parse(params.get("variables") || "null");
      if (!variables || typeof variables !== "object") return name;
      const kept = {};
      for (const [key, value] of Object.entries(variables)) {
        if (!PAGINATION_VARIABLES.has(key)) kept[key] = value;
      }
      observedQueryVariables = { ...observedQueryVariables, ...kept };
      return name;
    } catch {
      return "";
    }
  }

  function rememberPageResponse(name, status, text) {
    if (name !== "PolarisProfilePostsTabContentQuery_connection") return;
    lastPageResponse = { status, text: String(text ?? "") };
  }

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function send(body) {
    const name = rememberQueryVariables(body);
    if (name) {
      this.addEventListener("loadend", () => {
        let text = "";
        try { text = this.responseType === "" || this.responseType === "text" ? this.responseText : `[${this.responseType}]`; } catch {}
        rememberPageResponse(name, this.status, text);
      });
    }
    return nativeSend.apply(this, arguments);
  };

  const nativeFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    const name = rememberQueryVariables(init?.body);
    const result = nativeFetch.apply(this, arguments);
    if (name) {
      result.then((response) => response.clone().text()
        .then((text) => rememberPageResponse(name, response.status, text)))
        .catch(() => {});
    }
    return result;
  };

  function queryVariables(query, cursor, username) {
    const variables = {
      ...DEFAULT_QUERY_VARIABLES,
      ...observedQueryVariables,
      after: cursor,
      before: null,
      first: 12,
      last: null,
      username
    };
    // Fill any variable Instagram added to the query that we don't know about yet.
    const definitions = query.fragment?.argumentDefinitions || query.operation?.argumentDefinitions || [];
    for (const definition of definitions) {
      if (definition.name in variables) continue;
      variables[definition.name] = definition.defaultValue ?? null;
    }
    return variables;
  }

  function openCacheDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE_NAME)) {
          request.result.createObjectStore(CACHE_STORE_NAME, { keyPath: "username" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readCachedProfile(username) {
    const database = await openCacheDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = database
          .transaction(CACHE_STORE_NAME, "readonly")
          .objectStore(CACHE_STORE_NAME)
          .get(username.toLowerCase());
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  async function writeCachedProfile(profile) {
    const database = await openCacheDatabase();
    try {
      await new Promise((resolve, reject) => {
        const request = database
          .transaction(CACHE_STORE_NAME, "readwrite")
          .objectStore(CACHE_STORE_NAME)
          .put(profile);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  function visiblePostCodes() {
    return [...document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')]
      .map((link) => link.pathname.match(/\/(?:p|reel)\/([^/]+)/)?.[1])
      .filter(Boolean);
  }

  function signedMediaExpiry(value) {
    if (typeof value !== "string" || !value.startsWith("http")) return null;

    try {
      const url = new URL(value);
      if (!/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)) return null;
      const encodedExpiry = url.searchParams.get("oe");
      if (!encodedExpiry || !/^[\da-f]+$/i.test(encodedExpiry)) return null;

      const expiry = Number.parseInt(encodedExpiry, 16) * 1000;
      return Number.isFinite(expiry) ? expiry : null;
    } catch {
      return null;
    }
  }

  function cacheExpiration(records, savedAt) {
    let earliestSignedExpiry = Infinity;
    const pending = [records];

    while (pending.length) {
      const value = pending.pop();
      const expiry = signedMediaExpiry(value);
      if (expiry !== null) earliestSignedExpiry = Math.min(earliestSignedExpiry, expiry);
      if (!value || typeof value !== "object") continue;
      pending.push(...Object.values(value));
    }

    const ageLimit = savedAt + CACHE_MAX_AGE_MS;
    const mediaLimit = Number.isFinite(earliestSignedExpiry)
      ? earliestSignedExpiry - CACHE_EXPIRY_SAFETY_MS
      : savedAt + CACHE_FALLBACK_AGE_MS;
    return Math.min(ageLimit, mediaLimit);
  }

  function emit(detail) {
    document.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail }));
  }

  function observableToPromise(observable) {
    if (typeof observable?.toPromise === "function") return observable.toPromise();
    return new Promise((resolve, reject) => {
      let latest;
      observable.subscribe({
        next(value) { latest = value; },
        error: reject,
        complete() { resolve(latest); }
      });
    });
  }

  function modules() {
    if (typeof require !== "function") {
      throw new Error("Instagram's module loader is not ready. Reload the profile and retry.");
    }

    const relay = require("relay-runtime");
    const cometRelay = require("CometRelay");
    const environmentFactory = require("PolarisRelayEnvironmentFactory");
    const currentUser = require("CurrentUser");
    const query = require("PolarisProfilePostsTabContentQuery_connection.graphql");
    const actorID = currentUser.getPossiblyNonFacebookUserID();
    const environment = environmentFactory.getForActorID(actorID);
    const fetchQuery = cometRelay.fetchQuery || relay.fetchQuery;

    if (!environment || typeof fetchQuery !== "function") {
      throw new Error("Instagram's live Relay environment is unavailable.");
    }

    return { environment, fetchQuery, query, relay };
  }

  function connectionID(relay, username) {
    return relay.ConnectionHandler.getConnectionID(
      "client:root",
      CONNECTION_KEY,
      { username }
    );
  }

  function parseResponseData(text) {
    // Instagram may send several JSON payloads separated by newlines; the first holds the page.
    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line);
        if (payload?.data?.[ROOT_FIELD]) return payload;
      } catch {
        // Keep looking.
      }
    }
    return null;
  }

  function readConnection(environment, id) {
    let value = null;
    environment.commitUpdate((store) => {
      const connection = store.get(id);
      if (!connection) return;
      const pageInfo = connection.getLinkedRecord("page_info");
      const edges = connection.getLinkedRecords("edges") || [];
      value = {
        edgeIDs: edges.map((edge) => edge.getDataID()),
        count: edges.length,
        endCursor: pageInfo?.getValue("end_cursor") ?? null,
        hasNextPage: Boolean(pageInfo?.getValue("has_next_page")),
        hasPreviousPage: Boolean(pageInfo?.getValue("has_previous_page")),
        startCursor: pageInfo?.getValue("start_cursor") ?? null
      };
    });
    return value;
  }

  function collectRecordSnapshot(environment, edgeIDs) {
    const source = environment.getStore().getSource();
    const records = {};
    const pending = [...edgeIDs];
    const visited = new Set();

    function queueReferences(value) {
      if (!value || typeof value !== "object") return;
      if (typeof value.__ref === "string") pending.push(value.__ref);
      if (Array.isArray(value.__refs)) pending.push(...value.__refs);
      for (const nested of Object.values(value)) {
        if (nested && typeof nested === "object") queueReferences(nested);
      }
    }

    while (pending.length) {
      const id = pending.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      const record = source.get(id);
      if (!record) continue;
      records[id] = JSON.parse(JSON.stringify(record, (_key, value) => {
        if (typeof value === "function" || typeof value === "symbol") return undefined;
        return value;
      }));
      queueReferences(record);
    }

    return records;
  }

  function publishRecordSnapshot(environment, records) {
    const source = environment.getStore().getSource();
    for (const [id, record] of Object.entries(records)) source.set(id, record);
    environment.getStore().notify();
  }

  function applyEdgeOrder(environment, connectionId, edgeIDs) {
    let count = 0;
    environment.commitUpdate((store) => {
      const connection = store.get(connectionId);
      if (!connection) return;
      const edges = edgeIDs.map((id) => store.get(id)).filter(Boolean);
      connection.setLinkedRecords(edges, "edges");
      const pageInfo = connection.getLinkedRecord("page_info");
      if (pageInfo) pageInfo.setValue(false, "has_next_page");
      count = edges.length;
    });
    return count;
  }

  function cacheMatchesPage(cache, expectedCount) {
    if (!cache || cache.engine !== ENGINE_VERSION) return false;
    if (!Array.isArray(cache.edgeIDs) || !cache.records || !Array.isArray(cache.codes)) {
      return false;
    }
    if (!Number.isFinite(cache.savedAt) || !Number.isFinite(cache.expiresAt)) return false;
    if (Date.now() >= cache.expiresAt) return false;
    if (expectedCount && cache.count !== expectedCount) return false;
    const currentCodes = visiblePostCodes();
    if (!currentCodes.length) return false;
    const cachedCodes = new Set(cache.codes);
    return currentCodes.every((code) => cachedCodes.has(code));
  }

  function restoreCachedProfile(session, cache) {
    publishRecordSnapshot(session.environment, cache.records);
    return applyEdgeOrder(
      session.environment,
      session.connectionId,
      cache.edgeIDs
    );
  }

  function restoreSession(session) {
    const { environment, connectionId, original } = session;
    environment.commitUpdate((store) => {
      const connection = store.get(connectionId);
      if (!connection) return;
      const edges = original.edgeIDs.map((id) => store.get(id)).filter(Boolean);
      connection.setLinkedRecords(edges, "edges");
      const pageInfo = connection.getLinkedRecord("page_info");
      if (pageInfo) {
        pageInfo.setValue(original.endCursor, "end_cursor");
        pageInfo.setValue(original.hasNextPage, "has_next_page");
        pageInfo.setValue(original.hasPreviousPage, "has_previous_page");
        pageInfo.setValue(original.startCursor, "start_cursor");
      }
    });
  }

  function sortConnectionOldestFirst(session) {
    let result = { count: 0, edgeIDs: [], codes: [] };
    session.environment.commitUpdate((store) => {
      const connection = store.get(session.connectionId);
      if (!connection) return;
      const edges = connection.getLinkedRecords("edges") || [];
      const indexed = edges.map((edge, index) => {
        const node = edge.getLinkedRecord("node");
        return {
          edge,
          index,
          timestamp: Number(node?.getValue("taken_at") ?? 0)
        };
      });
      indexed.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
      const unique = [];
      const nodeIDs = new Set();
      for (const item of indexed) {
        const nodeID = item.edge.getLinkedRecord("node")?.getDataID();
        if (!nodeID || nodeIDs.has(nodeID)) continue;
        nodeIDs.add(nodeID);
        unique.push(item.edge);
      }
      connection.setLinkedRecords(unique, "edges");
      const pageInfo = connection.getLinkedRecord("page_info");
      if (pageInfo) pageInfo.setValue(false, "has_next_page");
      result = {
        count: unique.length,
        edgeIDs: unique.map((edge) => edge.getDataID()),
        codes: unique
          .map((edge) => edge.getLinkedRecord("node")?.getValue("code"))
          .filter(Boolean)
      };
    });
    return result;
  }

  async function start(username, expectedCount) {
    const token = ++runToken;
    if (activeSession) {
      restoreSession(activeSession);
      activeSession = null;
    }

    try {
      const { environment, fetchQuery, query, relay } = modules();
      const connectionId = connectionID(relay, username);
      const original = readConnection(environment, connectionId);
      if (!original) {
        throw new Error("Instagram's profile-post Relay connection was not found.");
      }

      const session = { environment, connectionId, original, phase: "loading" };
      activeSession = session;

      let cache = null;
      try {
        cache = await readCachedProfile(username);
      } catch (error) {
        console.warn("[Instagram Oldest First] Could not read the saved profile cache.", error);
      }

      if (token !== runToken) return;
      if (cacheMatchesPage(cache, expectedCount)) {
        emit({ phase: "cache-hit", count: cache.count, total: expectedCount });
        const count = restoreCachedProfile(session, cache);
        if (count === cache.count) {
          session.phase = "oldest";
          emit({ phase: "complete", count, total: expectedCount, cached: true });
          return;
        }
        restoreSession(session);
      }

      let cursor = original.endCursor;
      let hasNext = original.hasNextPage;
      let loaded = original.count;
      const cursors = new Set();

      emit({ phase: "loading", count: loaded, total: expectedCount });

      while (hasNext && token === runToken) {
        if (!cursor || cursors.has(cursor)) {
          throw new Error("Instagram returned a repeated or missing Relay cursor.");
        }
        cursors.add(cursor);

        const variables = queryVariables(query, cursor, username);
        lastPageResponse = null;
        let result;
        try {
          result = await observableToPromise(fetchQuery(
            environment,
            query,
            variables,
            { fetchPolicy: "network-only" }
          ));
        } catch (error) {
          throw new Error(`Instagram rejected the page request: ${error?.message || error}`);
        }

        if (token !== runToken) return;
        const current = readConnection(environment, connectionId);
        // On the last page Instagram returns end_cursor null and Relay keeps the old cursor,
        // so an unchanged cursor only means trouble when another page is still expected.
        if (
          !current ||
          current.count <= loaded ||
          (current.hasNextPage && current.endCursor === cursor)
        ) {
          console.warn("[Instagram Oldest First] Page did not append.", {
            variables,
            result,
            response: lastPageResponse && { ...lastPageResponse, text: lastPageResponse.text.slice(0, 2000) },
            before: { count: loaded, cursor },
            after: current
          });
          const page = parseResponseData(lastPageResponse?.text)?.data?.[ROOT_FIELD];
          const pageCodes = (page?.edges || []).map((edge) => edge?.node?.code).filter(Boolean);
          const haveCodes = new Set(visiblePostCodes());
          const detail = [
            ENGINE_VERSION,
            `had ${loaded} (start ${original.count})`,
            `store now ${current?.count ?? "missing"}`,
            `HTTP ${lastPageResponse?.status ?? "none"}`,
            `page ${pageCodes.length} posts ${pageCodes[0] ?? "-"}…${pageCodes.at(-1) ?? "-"}`,
            `${pageCodes.filter((code) => haveCodes.has(code)).length} already shown`,
            `next ${page?.page_info?.has_next_page}`,
            `cursor sent ${String(cursor).slice(0, 24)}`,
            `cursor back ${String(page?.page_info?.end_cursor).slice(0, 24)}`
          ].join(" · ");
          throw new Error(`Page did not append [${detail}]`);
        }
        loaded = current.count;
        cursor = current.endCursor;
        hasNext = current.hasNextPage;
        emit({ phase: "loading", count: loaded, total: expectedCount });
      }

      if (token !== runToken) return;
      const sorted = sortConnectionOldestFirst(session);
      emit({ phase: "saving", count: sorted.count, total: expectedCount });
      try {
        const records = collectRecordSnapshot(environment, sorted.edgeIDs);
        const savedAt = Date.now();
        await writeCachedProfile({
          username: username.toLowerCase(),
          engine: ENGINE_VERSION,
          count: sorted.count,
          codes: sorted.codes,
          edgeIDs: sorted.edgeIDs,
          records,
          savedAt,
          expiresAt: cacheExpiration(records, savedAt)
        });
      } catch (error) {
        console.warn("[Instagram Oldest First] Could not save the profile cache.", error);
      }

      if (token !== runToken) return;
      session.phase = "oldest";
      emit({ phase: "complete", count: sorted.count, total: expectedCount, cached: false });
    } catch (error) {
      if (token !== runToken) return;
      if (activeSession) {
        restoreSession(activeSession);
        activeSession = null;
      }
      emit({ phase: "error", message: error?.message || String(error) });
    }
  }

  function stopOrRestore() {
    runToken += 1;
    if (activeSession) {
      restoreSession(activeSession);
      activeSession = null;
    }
    emit({ phase: "restored" });
  }

  document.addEventListener(COMMAND_EVENT, (event) => {
    const action = event.detail?.action;
    if (action === "start") {
      void start(String(event.detail.username), Number(event.detail.total) || null);
    } else if (action === "restore") {
      stopOrRestore();
    }
  });

  document.documentElement?.setAttribute(
    "data-instagram-oldest-first-engine",
    ENGINE_VERSION
  );
})();
