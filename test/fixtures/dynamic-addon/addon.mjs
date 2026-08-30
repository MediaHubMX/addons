// Answers from code and echoes the query back, so a test can see whether the
// query survived the mount rewrite.
export async function get(pathname, query, ctx) {
  // What the third argument carries: the credential the client sent, and the
  // identity read out of it. Echoed so a test can see whether both survive the
  // loopback a v1 request takes through the bridge.
  if (pathname === "/identity.json") {
    return {
      credential: ctx?.headers?.["mediahubmx-signature"] ?? null,
      identity: (await ctx?.identity()) ?? null,
    };
  }

  // A promise nobody waits for, the way a background refresh loses its
  // upstream. Node ends the process over it unless the host says otherwise.
  if (pathname === "/boom.json") {
    Promise.reject(new Error("stray promise"));
    return null;
  }

  // The other kind of bad day: the addon's upstream answers with an error and
  // the addon says so. The request still has to end as a reply.
  if (pathname === "/throws.json") {
    throw new Error("upstream said 403");
  }

  // Asking the client to fetch: the id carries what to do with the answer, so
  // nothing has to be remembered here.
  if (pathname === "/source/video/far.json") {
    return { clientFetch: { id: "src:far", url: "https://upstream.invalid/geo.json" } };
  }
  // Same report as /identity.json, reachable through the v1 catalog action, so
  // a test can watch the credential cross the bridge loopback.
  if (pathname === "/catalog/video/identity.json") {
    return {
      items: [
        {
          id: "identity",
          type: "video",
          name: `credential=${ctx?.headers?.["mediahubmx-signature"] ?? "none"}`,
        },
      ],
      nextCursor: null,
    };
  }
  if (pathname !== "/catalog/video/all.json") return null;
  const search = query.get("search") || "";
  return {
    items: [{ id: "q", type: "video", name: `search=${search} cursor=${query.get("cursor") || ""}` }],
    nextCursor: null,
  };
}

export async function clientFetch(result) {
  if (result.id !== "src:far") return null;
  return { sources: [{ url: `https://cdn.invalid/${result.status}.m3u8`, name: result.body }] };
}
