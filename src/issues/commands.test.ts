import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIssueRepos } from "./commands.ts";

test("host=<id> pins a repository to that machine, and host=auto or no host= picks one per job", () => {
  assert.deepEqual(parseIssueRepos("acme/web project=prj_web host=host_mini\nAcme/API project=prj_api host=auto\n\nacme/docs project=prj_docs  # any machine\n"), {
    ok: true,
    repos: [
      { repo: "acme/web", projectId: "prj_web", hostId: "host_mini" },
      { repo: "acme/api", projectId: "prj_api", hostId: null },
      { repo: "acme/docs", projectId: "prj_docs", hostId: null },
    ],
  });
});

test("a line without a project, with an empty host, or naming a repository twice is refused", () => {
  assert.deepEqual(parseIssueRepos("acme/web host=host_mini\nacme/api project=prj_api host=\nacme/docs project=a\nacme/docs project=b host=auto"), {
    ok: false,
    errors: [
      'line 1: expected "owner/name project=<projectId> [host=<hostId>|host=auto]"',
      'line 2: expected "owner/name project=<projectId> [host=<hostId>|host=auto]"',
      "line 4: acme/docs appears twice",
    ],
  });
});
