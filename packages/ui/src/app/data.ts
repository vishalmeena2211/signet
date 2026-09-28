// Queries every place shares. The socket invalidates them; the intervals are the
// backstop for a dropped connection.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { DeskView } from "@signet/contracts";
import { api } from "../api.js";

export function useDesk(): UseQueryResult<DeskView> {
  return useQuery({ queryKey: ["desk"], queryFn: api.desk, refetchInterval: 5000 });
}
