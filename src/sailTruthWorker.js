/**
 * Web Worker for the sail "truth" stage of the solution checker, which can take
 * several seconds on large submissions. Input: { rows, segments }. Posts
 * { progress } updates and finally { result } (see validator.checkSailTruth).
 */
import { checkSailTruth } from './validator.js';

self.onmessage = (e) => {
  const { rows, segments } = e.data;
  const result = checkSailTruth(rows, segments, (done, total) => self.postMessage({ progress: done / total }));
  self.postMessage({ result });
};
