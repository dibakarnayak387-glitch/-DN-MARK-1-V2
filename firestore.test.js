const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const ALICE_UID = "alice_mark1_uid";
const BOB_UID = "bob_mark1_uid";

const [emulatorHost, emulatorPortStr] = (
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085"
).split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

test("Unauthenticated users cannot access any D.N. Mark 1 collection", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  const now = new Date(Date.now() - 1000);

  await assertFails(
    unauthDb.collection("users").doc(ALICE_UID).collection("conversations").get()
  );
  await assertFails(
    unauthDb.collection("users").doc(ALICE_UID).collection("tasks").get()
  );
  await assertFails(
    unauthDb.collection("users").doc(ALICE_UID).collection("memories").get()
  );
  await assertFails(
    unauthDb.collection("users").doc(ALICE_UID).collection("reminders").get()
  );
  await assertFails(
    unauthDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("memories")
      .doc("mem_1")
      .set({
        userId: ALICE_UID,
        category: "PREFERENCE",
        title: "Lang",
        content: "Prefers Hindi",
        language: "hi",
        approvedByUser: true,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
  );
});

test("Conversations: owner create, update, list, delete succeed; ghost fields and cross-user fail", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const created = new Date(Date.now() - 5000);

  const convRef = aliceDb
    .collection("users")
    .doc(ALICE_UID)
    .collection("conversations")
    .doc("msg_001");

  await assertSucceeds(
    convRef.set({
      userId: ALICE_UID,
      role: "USER",
      text: "Jarvis, check my battery and weather",
      language: "en",
      createdAt: created,
      updatedAt: created,
    })
  );

  // List query matching Kotlin repository
  await assertSucceeds(
    aliceDb.collection("users").doc(ALICE_UID).collection("conversations").get()
  );

  // Partial update allowed fields
  await assertSucceeds(
    convRef.update({
      linkedTaskId: "task_001",
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  // Cross-user read/write blocked
  await assertFails(
    bobDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("conversations")
      .doc("msg_001")
      .get()
  );
  await assertFails(
    bobDb.collection("users").doc(ALICE_UID).collection("conversations").get()
  );

  // Ghost field & @DocumentId 'id' blocked
  await assertFails(
    aliceDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("conversations")
      .doc("msg_002")
      .set({
        id: "msg_002",
        userId: ALICE_UID,
        role: "USER",
        text: "Bad payload",
        language: "en",
        createdAt: created,
        updatedAt: created,
      })
  );

  // Future timestamp blocked
  await assertFails(
    aliceDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("conversations")
      .doc("msg_003")
      .set({
        userId: ALICE_UID,
        role: "USER",
        text: "Future timestamp",
        language: "en",
        createdAt: new Date(Date.now() + 60000),
        updatedAt: new Date(Date.now() + 60000),
      })
  );

  await assertSucceeds(convRef.delete());
});

test("AgentTasks: full lifecycle, retry from FAILED, terminal lock on COMPLETED, and security bounds", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const created = new Date(Date.now() - 10000);

  const taskRef = aliceDb
    .collection("users")
    .doc(ALICE_UID)
    .collection("tasks")
    .doc("task_101");

  await assertSucceeds(
    taskRef.set({
      userId: ALICE_UID,
      title: "Morning Brief",
      description: "Check battery, weather, and search YouTube",
      language: "en",
      status: "RUNNING",
      progressPercent: 33,
      stepsCount: 3,
      completedStepsCount: 1,
      stepsSummary: ["[DONE] check_battery: 88%"],
      requiresConfirmation: false,
      createdAt: created,
      updatedAt: created,
    })
  );

  // Transition to FAILED then retry back to RUNNING
  await assertSucceeds(
    taskRef.update({
      status: "FAILED",
      errorMessage: "Weather network timeout",
      updatedAt: new Date(Date.now() - 3000),
    })
  );

  await assertSucceeds(
    taskRef.update({
      status: "RUNNING",
      errorMessage: null,
      progressPercent: 66,
      completedStepsCount: 2,
      stepsSummary: ["[DONE] check_battery: 88%", "[DONE] get_weather: 29C"],
      updatedAt: new Date(Date.now() - 2000),
    })
  );

  // Complete task
  await assertSucceeds(
    taskRef.update({
      status: "COMPLETED",
      progressPercent: 100,
      completedStepsCount: 3,
      stepsSummary: [
        "[DONE] check_battery: 88%",
        "[DONE] get_weather: 29C",
        "[DONE] youtube_search: Opened",
      ],
      summary: "All 3 steps verified.",
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  // Terminal lock: COMPLETED tasks cannot be mutated further
  await assertFails(
    taskRef.update({
      status: "RUNNING",
      updatedAt: new Date(Date.now() - 500),
    })
  );

  // Cross-user isolation
  await assertFails(
    bobDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("tasks")
      .doc("task_101")
      .get()
  );
  await assertFails(
    bobDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("tasks")
      .doc("task_101")
      .delete()
  );
});

test("Memories: requires approvedByUser=true, supports edit/pin/delete, blocks unapproved & spoofing", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const created = new Date(Date.now() - 8000);

  // Unapproved memory must be rejected by rules
  await assertFails(
    aliceDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("memories")
      .doc("mem_unapproved")
      .set({
        userId: ALICE_UID,
        category: "FACT",
        title: "Home city",
        content: "Bhubaneswar",
        language: "or",
        approvedByUser: false,
        pinned: false,
        createdAt: created,
        updatedAt: created,
      })
  );

  const memRef = aliceDb
    .collection("users")
    .doc(ALICE_UID)
    .collection("memories")
    .doc("mem_approved");

  await assertSucceeds(
    memRef.set({
      userId: ALICE_UID,
      category: "PREFERENCE",
      title: "Preferred language",
      content: "Respond in Odia when greeted in Odia",
      language: "or",
      approvedByUser: true,
      pinned: true,
      createdAt: created,
      updatedAt: created,
    })
  );

  await assertSucceeds(
    memRef.update({
      content: "Respond in Odia or Hindi depending on prompt",
      pinned: false,
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  // Immutable createdAt cannot be modified
  await assertFails(
    memRef.update({
      createdAt: new Date(Date.now() - 500),
      updatedAt: new Date(Date.now() - 500),
    })
  );

  await assertSucceeds(aliceDb.collection("users").doc(ALICE_UID).collection("memories").get());
  await assertSucceeds(memRef.delete());
});

test("Reminders: owner create, toggle completed, delete succeed; cross-user fails", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const created = new Date(Date.now() - 5000);

  const remRef = aliceDb
    .collection("users")
    .doc(ALICE_UID)
    .collection("reminders")
    .doc("rem_1");

  await assertSucceeds(
    remRef.set({
      userId: ALICE_UID,
      title: "Call Divakar Nayak",
      notes: "Follow up on project update",
      scheduledTimeLabel: "Today 6:00 PM",
      completed: false,
      createdAt: created,
      updatedAt: created,
    })
  );

  await assertSucceeds(
    remRef.update({
      completed: true,
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  await assertFails(
    bobDb
      .collection("users")
      .doc(ALICE_UID)
      .collection("reminders")
      .doc("rem_1")
      .update({ completed: false, updatedAt: new Date(Date.now() - 500) })
  );

  await assertSucceeds(remRef.delete());
});
