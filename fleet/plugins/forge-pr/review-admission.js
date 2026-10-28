// Verify fresh Forge identity and the protected host response before scheduling.
export function reviewAdmissionFor(companyId, forgeGet, invoke) {
	return async (event) => {
		try {
			const repo = await forgeGet(`/repos/${event.repo}`);
			const pr = await forgeGet(`/repos/${event.repo}/pulls/${event.number}`);
			if (
				pr.state !== "open" ||
				pr.head?.sha !== event.headSha ||
				pr.base?.repo?.id !== repo.id ||
				repo.full_name?.toLowerCase() !== event.repo.toLowerCase()
			)
				return { action: "hold", cause: "head_changed" };
			const result = await invoke({
				companyId,
				repositoryId: repo.id,
				repositoryFullName: repo.full_name,
				pr: event.number,
				headSha: pr.head.sha,
				baseSha: pr.base.sha,
			});
			if (
				!["start", "attach"].includes(result?.action) ||
				typeof result.workItemId !== "string" ||
				typeof result.reservation?.key !== "string" ||
				typeof result.reservation?.runId !== "string" ||
				!Number.isSafeInteger(result.reservation?.version) ||
				result.reservation.version < 1
			)
				return { action: "hold", cause: "admission_refused" };
			// A lost or partial board-create response needs trusted reconciliation.
			// The board lacks idempotent creation: attach must never dispatch again.
			if (result.action === "attach") return { action: "hold", cause: "reconciliation_required" };
			return result;
		} catch {
			return { action: "hold", cause: "trusted_admission_unavailable" };
		}
	};
}
