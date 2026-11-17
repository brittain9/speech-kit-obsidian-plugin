export type NoteSurfaceAdmissionReason = 'processing_region' | 'editor_rejected';

/** A destination refusal before a session acquires microphone audio or editor ownership. */
export class NoteSurfaceAdmissionError extends Error {
  constructor(readonly reason: NoteSurfaceAdmissionReason) {
    super(`Dictation destination refused: ${reason}`);
    this.name = 'NoteSurfaceAdmissionError';
  }
}
