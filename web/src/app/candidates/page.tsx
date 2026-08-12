import { CandidatePoolView } from "@/components/candidate-pool-view";
import { readCandidatePool } from "@/lib/candidate-pool";

// Keep discovery data fresh when the local importer refreshes its JSON.
export const dynamic = "force-dynamic";

export default function CandidatesPage() {
  return <CandidatePoolView pool={readCandidatePool()} />;
}
