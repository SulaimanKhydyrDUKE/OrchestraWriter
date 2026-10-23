// Lambda entry points. One container image, one function per export; each
// function's image config sets the handler, e.g. CMD ["pipeline/lambda.split"].
export { split, transcribe, merge, notate } from "./steps.js";
export { finalize, markFailed as fail } from "./finalize.js";
