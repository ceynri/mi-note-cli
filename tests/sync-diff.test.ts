import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, decide } from "../src/sync-diff.ts";
import type { Scenario, SyncAction } from "../src/sync-diff.ts";
import type { SyncMode } from "../src/types.ts";

// ============ classify：3-way 场景判定 ============

test("classify #1 三方一致", () => {
  assert.equal(classify({ baseHash: "a", remoteHash: "a", localHash: "a" }), "in-sync");
});

test("classify #2 仅云端改", () => {
  assert.equal(
    classify({ baseHash: "a", remoteHash: "b", localHash: "a" }),
    "remote-changed",
  );
});

test("classify #3 仅本地改", () => {
  assert.equal(
    classify({ baseHash: "a", remoteHash: "a", localHash: "b" }),
    "local-changed",
  );
});

test("classify #4 双改冲突", () => {
  assert.equal(
    classify({ baseHash: "a", remoteHash: "b", localHash: "c" }),
    "both-changed",
  );
});

test("classify #4 双改但内容恰好相同 → 视为已同步", () => {
  assert.equal(
    classify({ baseHash: "a", remoteHash: "b", localHash: "b" }),
    "in-sync",
  );
});

test("classify #5 云端新增（无基线）", () => {
  assert.equal(classify({ remoteHash: "a" }), "remote-new");
});

test("classify #6 本地新增（无基线）", () => {
  assert.equal(classify({ localHash: "a" }), "local-new");
});

test("classify 无基线两端都有且相同 → 已同步", () => {
  assert.equal(classify({ remoteHash: "a", localHash: "a" }), "in-sync");
});

test("classify 无基线两端都有但不同 → 双改冲突", () => {
  assert.equal(classify({ remoteHash: "a", localHash: "b" }), "both-changed");
});

test("classify #7 云删本地未改", () => {
  assert.equal(
    classify({ baseHash: "a", localHash: "a" }),
    "remote-deleted-local-clean",
  );
});

test("classify #8 云删本地改", () => {
  assert.equal(
    classify({ baseHash: "a", localHash: "b" }),
    "remote-deleted-local-changed",
  );
});

test("classify #9 本地删云未改", () => {
  assert.equal(
    classify({ baseHash: "a", remoteHash: "a" }),
    "local-deleted-remote-clean",
  );
});

test("classify #10 本地删云改", () => {
  assert.equal(
    classify({ baseHash: "a", remoteHash: "b" }),
    "local-deleted-remote-changed",
  );
});

test("classify #11 两端都删", () => {
  assert.equal(classify({ baseHash: "a" }), "both-deleted");
});

// ============ decide：场景 × mode → 动作 ============

const MODES: SyncMode[] = ["download", "mirror", "upload", "two-way", "manual"];

/** 期望动作表：每个场景在 5 个 mode 下的动作 */
const EXPECT: Record<Scenario, Record<SyncMode, SyncAction>> = {
  "in-sync": {
    download: "skip", mirror: "skip", upload: "skip", "two-way": "skip", manual: "skip",
  },
  "remote-changed": {
    download: "update-local", mirror: "update-local", upload: "skip",
    "two-way": "update-local", manual: "update-local",
  },
  "local-changed": {
    download: "skip", mirror: "skip", upload: "update-remote",
    "two-way": "update-remote", manual: "conflict",
  },
  "remote-new": {
    download: "create-local", mirror: "create-local", upload: "skip",
    "two-way": "create-local", manual: "create-local",
  },
  "local-new": {
    download: "skip", mirror: "skip", upload: "create-remote",
    "two-way": "create-remote", manual: "conflict",
  },
  "remote-deleted-local-clean": {
    download: "delete-local", mirror: "delete-local", upload: "create-remote",
    "two-way": "delete-local", manual: "conflict",
  },
  "local-deleted-remote-clean": {
    download: "create-local", mirror: "create-local", upload: "delete-remote",
    "two-way": "delete-remote", manual: "conflict",
  },
  "both-deleted": {
    download: "drop-state", mirror: "drop-state", upload: "drop-state",
    "two-way": "drop-state", manual: "drop-state",
  },
  "both-changed": {
    download: "update-local", mirror: "update-local", upload: "update-remote",
    "two-way": "conflict", manual: "conflict",
  },
  "remote-deleted-local-changed": {
    download: "delete-local", mirror: "delete-local", upload: "update-remote",
    "two-way": "conflict", manual: "conflict",
  },
  "local-deleted-remote-changed": {
    download: "update-local", mirror: "update-local", upload: "delete-remote",
    "two-way": "conflict", manual: "conflict",
  },
};

for (const scenario of Object.keys(EXPECT) as Scenario[]) {
  for (const mode of MODES) {
    test(`decide: ${scenario} × ${mode} → ${EXPECT[scenario][mode]}`, () => {
      assert.equal(decide(scenario, mode), EXPECT[scenario][mode]);
    });
  }
}

// ============ 关键安全性质 ============

test("性质：manual 模式下所有真冲突都返回 conflict", () => {
  for (const s of ["both-changed", "remote-deleted-local-changed", "local-deleted-remote-changed"] as Scenario[]) {
    assert.equal(decide(s, "manual"), "conflict");
  }
});

test("性质：two-way 模式下真冲突返回 conflict（不自动猜）", () => {
  for (const s of ["both-changed", "remote-deleted-local-changed", "local-deleted-remote-changed"] as Scenario[]) {
    assert.equal(decide(s, "two-way"), "conflict");
  }
});

test("性质：download/mirror 永不上行（不产生 update-remote/create-remote/delete-remote）", () => {
  const uplink: SyncAction[] = ["update-remote", "create-remote", "delete-remote"];
  for (const s of Object.keys(EXPECT) as Scenario[]) {
    assert.ok(!uplink.includes(decide(s, "download")), `download 不应上行: ${s}`);
    assert.ok(!uplink.includes(decide(s, "mirror")), `mirror 不应上行: ${s}`);
  }
});
