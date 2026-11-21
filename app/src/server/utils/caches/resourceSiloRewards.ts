import { findResourceSilo } from "@/queries/resourceSilos";
import type { DrizzleClient } from "@/server/db";
import { createRuntimeCache } from "@/server/utils/caches/runtimeCache";

// Every profile read decides whether to show the open-silo notice, while silo rewards
// change only through the staff editor's save, which invalidates this flag. Instances
// check the shared version once a minute, so a newly configured silo can reach players
// served by another instance up to a minute late.
const resourceSiloRewards = createRuntimeCache({
  name: "resource-silo-rewards",
  ttlSeconds: 10 * 60,
  memorySeconds: 60,
  cloneReads: false,
  load: async (client: DrizzleClient) =>
    !!(await findResourceSilo(client))?.entries.some((entry) => entry.chance > 0),
});

/** Whether any silo reward has a drop chance, so an open window can be claimed. */
export const hasResourceSiloRewards = (client: DrizzleClient) =>
  resourceSiloRewards.read(client);

/** Make every instance read the silo rewards again; await after the editor saves them. */
export const invalidateResourceSiloRewards = resourceSiloRewards.invalidate;
