/**
 * crank-health's bundled SAST ruleset — written here, from scratch, and shipped
 * offline.
 *
 * **Why we wrote our own.** The engines in this space are open source; the
 * *rules* mostly are not. The semgrep registry's packs (`p/security-audit`,
 * `p/owasp-top-ten`, …) carry terms that restrict redistribution and competing
 * use, and those terms follow the rules wherever they are fetched from —
 * including into opengrep. Every rule below is original work by this project
 * and ships under the same MIT license as the rest of crank-health, which
 * removes the question entirely.
 *
 * **What it is not.** Fourteen rules are not a security audit; they are the
 * unambiguous, low-false-positive core — the patterns where the finding is the
 * defect and no context can make it fine. A repo that needs registry packs can
 * still run opengrep itself. crank-health never fetches them: see
 * `opengrep.ts`, where `--config` always points at this file materialized in
 * the scratch dir and `auto` is unreachable.
 *
 * **Constraints on edits.** Rule ids must not contain a dot: opengrep prefixes
 * every `check_id` with the path of the file the rule came from, and stripping
 * that prefix — which contains the scratch dir, and would otherwise make report
 * ids machine-dependent — works by taking the segment after the last dot.
 * `severity` maps to our vocabulary in `opengrep.ts`: ERROR → `error`,
 * WARNING → `warning`, INFO → `info`.
 */

/**
 * The ruleset, materialized into the scratch dir at run time. A string constant
 * rather than a `.yaml` asset because the CLI ships as a single bundled
 * `dist/cli.js` — a file next to the source would not survive bundling.
 */
export const OPENGREP_RULES = `# crank-health's bundled SAST rules.
# Original work, MIT-licensed with the rest of crank-health. No registry packs.
rules:
  - id: js-eval-call
    languages: [javascript, typescript]
    severity: ERROR
    message: >-
      eval() executes its argument as code. Any value reaching it from a
      request, a file or a user is remote code execution.
    metadata:
      cwe: "CWE-95"
    patterns:
      - pattern: eval(...)
      - pattern-not: eval("...")

  - id: js-function-constructor
    languages: [javascript, typescript]
    severity: ERROR
    message: >-
      The Function constructor compiles a string into code, exactly like eval().
      Build the behaviour you need instead of generating source.
    metadata:
      cwe: "CWE-95"
    patterns:
      - pattern-either:
          - pattern: new Function(...)
          - pattern: Function(...)
      - pattern-not: new Function()
      - pattern-not: Function()

  - id: js-child-process-shell
    languages: [javascript, typescript]
    severity: ERROR
    message: >-
      exec() and execSync() run their argument through a shell, so any
      interpolated value becomes shell syntax. Use execFile/spawn with an
      argument array.
    metadata:
      cwe: "CWE-78"
    patterns:
      - pattern-either:
          - pattern: $CP.exec(\`...\`, ...)
          - pattern: $CP.execSync(\`...\`, ...)
          - pattern: $CP.exec($A + $B, ...)
          - pattern: $CP.execSync($A + $B, ...)

  - id: js-innerhtml-assignment
    languages: [javascript, typescript]
    severity: WARNING
    message: >-
      Assigning to innerHTML parses the value as HTML, so any untrusted part of
      it becomes markup and script. Use textContent, or sanitize first.
    metadata:
      cwe: "CWE-79"
    patterns:
      - pattern-either:
          - pattern: $EL.innerHTML = $V
          - pattern: $EL.outerHTML = $V
      - pattern-not: $EL.innerHTML = "..."
      - pattern-not: $EL.outerHTML = "..."

  - id: js-tls-verification-disabled
    languages: [javascript, typescript]
    severity: ERROR
    message: >-
      Disabling TLS certificate verification makes every HTTPS connection
      trivially interceptable. Fix the certificate chain instead.
    metadata:
      cwe: "CWE-295"
    patterns:
      - pattern-either:
          - pattern: process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
          - pattern: process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
          - pattern: "rejectUnauthorized: false"

  - id: js-hardcoded-temp-path
    languages: [javascript, typescript]
    severity: WARNING
    message: >-
      A hardcoded path under /tmp is world-writable and predictable, so another
      process can win the race for it. Use fs.mkdtemp() or os.tmpdir().
    metadata:
      cwe: "CWE-377"
    patterns:
      - pattern-regex: '"/tmp/[A-Za-z0-9._-]+"'

  - id: python-eval-exec
    languages: [python]
    severity: ERROR
    message: >-
      eval() and exec() compile their argument as code. Any value reaching them
      from a request, a file or a user is remote code execution.
    metadata:
      cwe: "CWE-95"
    patterns:
      - pattern-either:
          - pattern: eval(...)
          - pattern: exec(...)
      - pattern-not: eval("...")
      - pattern-not: exec("...")

  - id: python-subprocess-shell-true
    languages: [python]
    severity: ERROR
    message: >-
      shell=True runs the command through a shell, so any interpolated value
      becomes shell syntax. Pass an argument list and leave shell=False.
    metadata:
      cwe: "CWE-78"
    patterns:
      - pattern: subprocess.$FN(..., shell=True, ...)

  - id: python-os-system
    languages: [python]
    severity: ERROR
    message: >-
      os.system() and os.popen() run their argument through a shell. Use
      subprocess.run() with an argument list.
    metadata:
      cwe: "CWE-78"
    patterns:
      - pattern-either:
          - pattern: os.system(...)
          - pattern: os.popen(...)

  - id: python-yaml-unsafe-load
    languages: [python]
    severity: ERROR
    message: >-
      yaml.load() without SafeLoader constructs arbitrary Python objects from
      the document. Use yaml.safe_load().
    metadata:
      cwe: "CWE-502"
    patterns:
      - pattern: yaml.load($D)

  - id: python-pickle-load
    languages: [python]
    severity: ERROR
    message: >-
      Unpickling executes code embedded in the payload. Never unpickle data you
      did not produce; use JSON for untrusted input.
    metadata:
      cwe: "CWE-502"
    patterns:
      - pattern-either:
          - pattern: pickle.load(...)
          - pattern: pickle.loads(...)
          - pattern: cPickle.load(...)
          - pattern: cPickle.loads(...)

  - id: python-sql-string-building
    languages: [python]
    severity: ERROR
    message: >-
      Building SQL by string formatting is how injection happens. Pass the
      values as query parameters instead.
    metadata:
      cwe: "CWE-89"
    patterns:
      - pattern-either:
          - pattern: $CUR.execute($Q % ...)
          - pattern: $CUR.execute($Q.format(...))
          - pattern: $CUR.execute($A + $B)
          - pattern: $CUR.executemany($Q % ...)
          - pattern: $CUR.executemany($Q.format(...))

  - id: python-requests-verify-disabled
    languages: [python]
    severity: ERROR
    message: >-
      verify=False disables TLS certificate checking, making the request
      trivially interceptable. Point requests at the right CA bundle instead.
    metadata:
      cwe: "CWE-295"
    patterns:
      - pattern: requests.$FN(..., verify=False, ...)

  - id: python-hardcoded-temp-path
    languages: [python]
    severity: WARNING
    message: >-
      A hardcoded path under /tmp is world-writable and predictable, so another
      process can win the race for it. Use tempfile.mkstemp() or
      tempfile.TemporaryDirectory().
    metadata:
      cwe: "CWE-377"
    patterns:
      - pattern-regex: "['\\"]/tmp/[A-Za-z0-9._-]+['\\"]"
`
