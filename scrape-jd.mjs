/**
 * scrape-jd.mjs — thin wrapper around browser-extract.mjs for the server pipeline.
 *
 * The server (server.mjs) needs a job description scraped from a URL as
 * `{ url, title, text }`. Rather than reimplement a scraper, this shells out to
 * the existing headless reader `browser-extract.mjs` in `--mode jd`, which already
 * renders the page with Playwright, applies the SSRF host guard, and prints
 * compact JSON `{ url, title, text }` to stdout (exit 0), or `{ error, code }` to
 * stderr (exit 1) on a hard error.
 *
 * Usage:
 *   import { scrapeJobDescription } from './scrape-jd.mjs';
 *   const { url, title, text } = await scrapeJobDescription('https://example.com/job');
 */

import { execFile } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Scrape a job description from a URL by delegating to browser-extract.mjs.
 *
 * @param {string} url - The job posting URL to scrape.
 * @param {Function} [runner=execFile] - Injectable child_process.execFile for tests.
 * @returns {Promise<{ url: string, title: string, text: string }>}
 * @throws {Error} If the extractor exits non-zero; the thrown Error message
 *   carries the extractor's `{ error, code }` when available.
 */
export function scrapeJobDescription(url, runner = execFile) {
  return new Promise((resolvePromise, reject) => {
    const script = join(__dirname, 'browser-extract.mjs');
    runner(
      process.execPath,
      [script, url, '--mode', 'jd'],
      { cwd: __dirname, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // browser-extract.mjs prints `{ error, code }` JSON to stderr on a
          // hard error. Surface that as the Error message when parseable.
          let message = error.message;
          const raw = (stderr || '').trim();
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && parsed.error) {
                message = parsed.code ? `${parsed.error} (${parsed.code})` : parsed.error;
              } else {
                message = raw;
              }
            } catch {
              message = raw;
            }
          }
          reject(new Error(message));
          return;
        }

        const out = (stdout || '').trim();
        let parsed;
        try {
          parsed = JSON.parse(out);
        } catch {
          reject(new Error(`Failed to parse extractor output as JSON: ${out.slice(0, 200)}`));
          return;
        }

        resolvePromise({
          url: parsed.url || url,
          title: parsed.title || '',
          text: parsed.text || '',
        });
      },
    );
  });
}
