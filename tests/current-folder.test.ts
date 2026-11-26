import test from "node:test";
import assert from "node:assert/strict";
import { newEntryFolder, PRIVATE_FOLDER } from "../src/folders";

test("new bookmarks go into the current folder", () => {
  assert.equal(newEntryFolder("", false), "");
  assert.equal(newEntryFolder("Work", false), "Work");
  assert.equal(newEntryFolder("Work/Projects", false), "Work/Projects");
});

test("incognito windows keep the incognito-only folder", () => {
  assert.equal(newEntryFolder("", true), PRIVATE_FOLDER);
  // A normal folder opened in an incognito window: still the private folder.
  assert.equal(newEntryFolder("Work", true), PRIVATE_FOLDER);
  assert.equal(newEntryFolder(PRIVATE_FOLDER, true), PRIVATE_FOLDER);
  assert.equal(
    newEntryFolder(PRIVATE_FOLDER + "/Sub", true),
    PRIVATE_FOLDER + "/Sub",
  );
  // A normal folder whose name only starts like the private one.
  assert.equal(newEntryFolder(PRIVATE_FOLDER + "x", true), PRIVATE_FOLDER);
});
