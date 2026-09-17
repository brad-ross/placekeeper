import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { setAnnotationName } from '../../../../packages/core/src/review-commands.js';
import { authoringAuthorityFor, type AuthoringAuthority } from '../review/authoring-session.js';
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
    readonly authority: AuthoringAuthority;
    readonly reason: "first-annotation" | "menu";
    readonly pending?: PendingAuthoringCommand;
  } | null>(null);
  const [copyProposal, setCopyProposal] = useState<SaveCopyProposal>();
  const [destinationEstablishing, setDestinationEstablishing] = useState(false);
  const [destinationError, setDestinationError] = useState<string>();
  const [nameError, setNameError] = useState<string>();
  const destinationAttemptRef = useRef(0);
  const folderChoiceVersionRef = useRef(0);
  const authoringResolutionTokenRef = useRef(0);
  useEffect(() => () => { destinationAttemptRef.current += 1; }, []);
  const [authoringSessionResolution, setAuthoringSessionResolution] = useState<{
    readonly token: number;
    readonly outcome: 'accepted' | 'source-replaced';
  }>();
  useEffect(() => {
    if (destinationDialog === null) return;
    let cancelled = false;
    const attempt = destinationAttemptRef.current;
    const isCurrent = () => !cancelled && pendingDestinationAttemptIsCurrent(attempt, destinationAttemptRef.current, destinationDialog, stateRef.current, documentGenerationRef.current);
    setDestinationError(undefined);
    const folderChoiceVersion = folderChoiceVersionRef.current;
    void props.api.saveProposal()
      .then((proposal) => {
        if (!isCurrent()) return;
        if (folderChoiceVersion === folderChoiceVersionRef.current) {
          setCopyProposal(proposal);
        } else {
          const filename = proposal.filename;
          if (filename !== undefined) setCopyProposal((current) => current === undefined
            ? proposal : { ...current, filename });
        }
      })
      .catch(() => {
        if (isCurrent()) setDestinationError("Save options could not be prepared safely.");
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
    setNameError(undefined);
    setDestinationEstablishing(false);
    setDestinationDialog({ authority: authoringAuthorityFor(stateRef.current, documentGenerationRef.current), reason, ...(pending === undefined ? {} : { pending }) });
  };
  const retrySave = async () => {
    if (destinationEstablishing) return;
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    const attempt = destinationAttemptRef.current;
    const captured = destinationDialog ?? { authority: authoringAuthorityFor(stateRef.current, documentGenerationRef.current) };
    const isCurrent = () => pendingDestinationAttemptIsCurrent(attempt, destinationAttemptRef.current, captured, stateRef.current, documentGenerationRef.current);
    try {
      const status = await props.api.retrySave();
      if (!isCurrent()) return;
      setSaveStatus(status);
      setDestinationDialog(null);
    } catch {
      if (!isCurrent()) return;
      setDestinationError('Saving could not be retried safely.');
    } finally {
      if (isCurrent()) setDestinationEstablishing(false);
    }
  };
  const invalidatePendingDestination = () => {
    const pending = destinationDialog;
    if (
      pending === null
      || pendingDestinationIsCurrent(pending, state, documentGenerationRef.current)
    ) return;
    destinationAttemptRef.current += 1;
    setDestinationEstablishing(false);
    const disposition = pendingDestinationDisposition('source-replaced');
    if (disposition.notifyAuthoringShell) publishAuthoringResolution('source-replaced');
    if (disposition.closeDialog) setDestinationDialog(null);
    setDestinationError(undefined);
    setNameError(undefined);
  };
  const onLocate = async () => {
    if (destinationEstablishing) return;
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    const attempt = destinationAttemptRef.current;
    const captured = destinationDialog ?? { authority: authoringAuthorityFor(stateRef.current, documentGenerationRef.current) };
    const isCurrent = () => pendingDestinationAttemptIsCurrent(attempt, destinationAttemptRef.current, captured, stateRef.current, documentGenerationRef.current);
    try {
      const status = await props.api.locateSave();
      if (!isCurrent()) return;
      setSaveStatus(status);
      setDestinationDialog(null);
    } catch {
      if (!isCurrent()) return;
      setDestinationError("The selected PDF did not match the saved file.");
    } finally {
      if (isCurrent()) setDestinationEstablishing(false);
    }
  };
  const onChooseLocation = async () => {
    const attempt = destinationAttemptRef.current;
    const captured = destinationDialog ?? { authority: authoringAuthorityFor(stateRef.current, documentGenerationRef.current) };
    const isCurrent = () => pendingDestinationAttemptIsCurrent(attempt, destinationAttemptRef.current, captured, stateRef.current, documentGenerationRef.current);
    try {
      const selected = await props.api.chooseFolder();
      if (!isCurrent()) return;
      if (!selected.cancelled && selected.selectionId && selected.folder) {
        const { selectionId, folder } = selected;
        folderChoiceVersionRef.current += 1;
        setCopyProposal((current) => scope.sourceDisposition === 'remote-temporary'
          ? { ...current, sourceDisposition: 'remote-temporary', folder, folderSelectionId: selectionId }
          : {
              sourceDisposition: 'local',
              filename: current?.sourceDisposition === 'local'
                ? current.filename
                : "annotated.pdf",
              folder,
              folderSelectionId: selectionId,
            });
      }
    } catch {
      if (!isCurrent()) return;
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
  const onConfirm = async (choice: "copy" | "original", filename: string, annotationName: string) => {
    const dialog = destinationDialog;
    if (dialog === null || destinationEstablishing) return;
    const attempt = destinationAttemptRef.current;
    const isCurrent = () => pendingDestinationAttemptIsCurrent(attempt,
      destinationAttemptRef.current, dialog, stateRef.current, documentGenerationRef.current);
    if (!isCurrent()) { invalidatePendingDestination(); return; }
    setDestinationEstablishing(true);
    setDestinationError(undefined);
    setNameError(undefined);
    try {
      const beforeName = stateRef.current;
      const confirmation = { command: setAnnotationName(beforeName, annotationName),
        expectedGeneration: beforeName.workflow.documentGeneration };
      const established = choice === "copy"
        ? await props.api.chooseCopy(filename, copyProposal?.folderSelectionId, confirmation)
        : await props.api.chooseOriginal(confirmation);
      if (!isCurrent()) return;
      setSaveStatus(established);
      const named = established.nameResult;
      if (named === undefined) throw new Error("The destination did not acknowledge the annotation name.");
      const acceptedState = 'accepted' in named ? named.state : named;
      if (!pendingDestinationIsCurrent(dialog, acceptedState, documentGenerationRef.current) ||
        acceptedState.workflow.documentGeneration !== beforeName.workflow.documentGeneration) return;
      if (acceptedState.revision >= stateRef.current.revision) {
        stateRef.current = acceptedState;
        setState(acceptedState);
      }
      if ('accepted' in named) {
        setNameError(named.message);
        return;
      }
      if (dialog.pending !== undefined) {
        // Only account for our own name command. An already stale draft must
        // still reach the runtime with its stale revision and be rejected.
        const pendingCommand = dialog.pending.command.expectedRevision === beforeName.revision
          ? { ...dialog.pending.command, expectedRevision: named.revision }
          : dialog.pending.command;
        const result = await props.api.command(pendingCommand);
        if (!isCurrent()) return;
        const next = "accepted" in result ? result.state : result;
        if (next.revision >= stateRef.current.revision) {
          stateRef.current = next;
          setState(next);
        }
        if ("accepted" in result) {
          setCommandError(result.message);
          setDestinationDialog(null);
          return;
        }
        setCommandError(null);
        publishAuthoringResolution('accepted');
      }
      const status = await props.api.saveStatus();
      if (!isCurrent()) return;
      setSaveStatus(status);
      setDestinationDialog(null);
    } catch (error) {
      if (isCurrent()) setDestinationError(error instanceof Error
        ? error.message : "That destination could not be established safely.");
    } finally {
      if (isCurrent()) setDestinationEstablishing(false);
    }
  };
  return { destinationDialog, copyProposal, destinationEstablishing, destinationError, nameError,
    authoringSessionResolution, openCopyDialog, retrySave, invalidatePendingDestination,
    onLocate, onChooseLocation, onCancel, onConfirm };
}
