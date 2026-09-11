import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from 'react';
import type { ReviewState } from '../../../../packages/core/src/review-model.js';
import type { SaveStatus } from '../../../../packages/core/src/save-status.js';
import type { SaveCopyProposal, ProductionScope, ProductionSessionApi } from '../host/session-contracts.js';
import { pendingDestinationDisposition, pendingDestinationIsCurrent, pendingDestinationAttemptIsCurrent,
  type PendingAuthoringCommand } from './destination-attempt.js';

/** Destination choice is a prerequisite; the authoring shell retains the draft.
 * Invalidation is called after the application's ordered generation reset. */
export function useSaveDestination(props: { api: ProductionSessionApi }, scope: ProductionScope,
  state: ReviewState, stateRef: RefObject<ReviewState>, documentGenerationRef: RefObject<number>,
  setState: Dispatch<SetStateAction<ReviewState>>, setSaveStatus: Dispatch<SetStateAction<SaveStatus>>,
  setCommandError: (error: string | null) => void) {
  const [destinationDialog, setDestinationDialog] = useState<{
    readonly reason: "first-annotation" | "menu";
    readonly pending?: PendingAuthoringCommand;
  } | null>(null);
  const [copyProposal, setCopyProposal] = useState<SaveCopyProposal>();
  const [folderSelectionId, setFolderSelectionId] = useState<string>();
  const [destinationEstablishing, setDestinationEstablishing] = useState(false);
  const [destinationError, setDestinationError] = useState<string>();
  const destinationAttemptRef = useRef(0);
  const authoringResolutionTokenRef = useRef(0);
  const [authoringSessionResolution, setAuthoringSessionResolution] = useState<{
    readonly token: number;
    readonly outcome: 'accepted' | 'source-replaced';
  }>();
  useEffect(() => {
    if (destinationDialog === null) return;
    let cancelled = false;
    setDestinationError(undefined);
    setFolderSelectionId(undefined);
    void props.api.saveProposal()
      .then((proposal) => {
        if (!cancelled) setCopyProposal((current) =>
          current?.sourceDisposition === 'remote-temporary' && current.folder !== undefined
            ? current
            : proposal);
      })
      .catch(() => {
        if (!cancelled) setDestinationError("Save options could not be prepared safely.");
      });
    return () => { cancelled = true; };
  }, [destinationDialog, props.api]);

  const publishAuthoringResolution = (outcome: 'accepted' | 'source-replaced') => {
    const disposition = pendingDestinationDisposition(outcome);
    if (!disposition.notifyAuthoringShell) return;
    setAuthoringSessionResolution({
      token: ++authoringResolutionTokenRef.current,
      outcome,
    });
  };
  const openCopyDialog = (
    reason: "first-annotation" | "menu",
    pending?: PendingAuthoringCommand,
  ) => {
    destinationAttemptRef.current += 1;
    setDestinationError(undefined);
    setCopyProposal(undefined);
    setDestinationDialog({ reason, ...(pending === undefined ? {} : { pending }) });
  };
  const retrySave = async () => {
    if (destinationEstablishing) return;
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    try {
      setSaveStatus(await props.api.retrySave());
      setDestinationDialog(null);
    } catch {
      setDestinationError('Saving could not be retried safely.');
    } finally {
      setDestinationEstablishing(false);
    }
  };
  const invalidatePendingDestination = () => {
    const pending = destinationDialog?.pending;
    if (
      pending === undefined
      || pendingDestinationIsCurrent(pending, state, documentGenerationRef.current)
    ) return;
    destinationAttemptRef.current += 1;
    setDestinationEstablishing(false);
    const disposition = pendingDestinationDisposition('source-replaced');
    if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
    if (disposition.closeDialog) setDestinationDialog(null);
    setDestinationError(undefined);
  };
  const onLocate = async () => {
    if (destinationEstablishing) return;
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    try {
      setSaveStatus(await props.api.locateSave());
      setDestinationDialog(null);
    } catch {
      setDestinationError("The selected PDF did not match the saved file.");
    } finally {
      setDestinationEstablishing(false);
    }
  };
  const onChooseLocation = async () => {
    try {
      const selected = await props.api.chooseFolder();
      if (!selected.cancelled && selected.selectionId && selected.folder) {
        setFolderSelectionId(selected.selectionId);
        setCopyProposal((current) => scope.sourceDisposition === 'remote-temporary'
          ? { sourceDisposition: 'remote-temporary', folder: selected.folder! }
          : {
              sourceDisposition: 'local',
              filename: current?.sourceDisposition === 'local'
                ? current.filename
                : "annotated.pdf",
              folder: selected.folder!,
            });
      }
    } catch {
      setDestinationError("A new location could not be authorized.");
    }
  };
  const onCancel = () => {
    if (destinationEstablishing) return;
    destinationAttemptRef.current += 1;
    const disposition = pendingDestinationDisposition('cancelled');
    if (disposition.closeDialog) setDestinationDialog(null);
    setDestinationError(undefined);
  };
  const onConfirm = async (choice: "copy" | "original", filename: string) => {
    const dialog = destinationDialog;
    if (dialog === null || destinationEstablishing) return;
    if (
      dialog.pending !== undefined
      && !pendingDestinationIsCurrent(
        dialog.pending,
        stateRef.current,
        documentGenerationRef.current,
      )
    ) {
      const disposition = pendingDestinationDisposition('source-replaced');
      if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
      if (disposition.closeDialog) setDestinationDialog(null);
      setDestinationError(undefined);
      return;
    }
    const attempt = destinationAttemptRef.current;
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    try {
      const established = choice === "copy"
        ? await props.api.chooseCopy(filename, folderSelectionId)
        : await props.api.chooseOriginal();
      if (!pendingDestinationAttemptIsCurrent(
        attempt,
        destinationAttemptRef.current,
        dialog.pending,
        stateRef.current,
        documentGenerationRef.current,
      )) {
        if (dialog.pending !== undefined && !pendingDestinationIsCurrent(
          dialog.pending,
          stateRef.current,
          documentGenerationRef.current,
        )) {
          const disposition = pendingDestinationDisposition('source-replaced');
          if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
          if (disposition.closeDialog) setDestinationDialog(null);
        }
        return;
      }
      setSaveStatus(established);
      if (dialog.pending !== undefined) {
        const result = await props.api.command(dialog.pending.command);
        if (!pendingDestinationAttemptIsCurrent(
          attempt,
          destinationAttemptRef.current,
          dialog.pending,
          stateRef.current,
          documentGenerationRef.current,
        )) {
          if (!pendingDestinationIsCurrent(
            dialog.pending,
            stateRef.current,
            documentGenerationRef.current,
          )) {
            const disposition = pendingDestinationDisposition('source-replaced');
            if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
            if (disposition.closeDialog) setDestinationDialog(null);
          }
          return;
        }
        const next = "accepted" in result ? result.state : result;
        setState(next);
        if ("accepted" in result) {
          const disposition = pendingDestinationDisposition('rejected');
          if (!disposition.preserveDraft) {
            throw new Error('Rejected annotation unexpectedly discarded its draft.');
          }
          setCommandError(result.message);
          setDestinationError(undefined);
          if (disposition.closeDialog) setDestinationDialog(null);
          return;
        }
        setCommandError(null);
        const disposition = pendingDestinationDisposition('accepted');
        if (disposition.notifyAuthoringShell) publishAuthoringResolution('accepted');
        setSaveStatus(await props.api.saveStatus());
        if (destinationAttemptRef.current !== attempt) return;
      }
      if (pendingDestinationDisposition('accepted').closeDialog) {
        setDestinationDialog(null);
      }
    } catch (error) {
      setDestinationError(
        error instanceof Error
          ? error.message
          : "That destination could not be established safely.",
      );
    } finally {
      setDestinationEstablishing(false);
    }
  };
  return { destinationDialog, copyProposal, destinationEstablishing, destinationError,
    authoringSessionResolution, openCopyDialog, retrySave, invalidatePendingDestination,
    onLocate, onChooseLocation, onCancel, onConfirm };
}
