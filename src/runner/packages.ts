/**
 * The fixed, author-owned package NAMES every runner lane is authorized to
 * apt-install when a required tool is absent from the golden image.
 *
 * These are the single source of truth for the four packet-body generators
 * (`src/prepush`, `src/doctor`, `src/compat`, `src/infra`). They are author
 * literals: a lane substitutes one of these constants into its fixed install
 * line and NEVER derives a package name from repository content, managed-repo
 * config, an index, or any discovery step. That — the name being fixed by the
 * author — is the security property. It is unchanged by this module.
 *
 * ## Why these carry no `=version` pin
 *
 * They used to. Each lane pinned an exact Debian version string
 * (`bubblewrap=0.8.0-2+deb12u1`, `postgresql-18=18.4-1.pgdg12+1`), and those
 * strings encoded a DISTRO RELEASE (`deb12` = bookworm, `pgdg12` = the PGDG
 * build for bookworm). When the runner fleet cut over to Debian 13 (trixie) on
 * 2026-08-02, every one of those pins became
 * unsatisfiable on every box:
 *
 *     E: Version '0.8.0-2+deb12u1' for 'bubblewrap' was not found
 *     E: Version '18.4-1.pgdg12+1' for 'postgresql-18' was not found
 *
 * That failure took out the pre-push receipt gate, which is this repository's
 * CI, and therefore blocked every push.
 *
 * A distro-release string embedded in a packet body is a time bomb: it re-fires
 * on every image upgrade, and it fires in the one place that blocks the fix
 * from landing. The version authority is now the IMAGE, which is built from
 * reviewed code (rtech-infra role `runner_golden_image`) — not a literal typed
 * into a job packet by a lane that cannot see which distro the box is running.
 *
 * So each lane now asserts-or-installs by NAME:
 *
 *   - If the image already ships the package, `apt-get install -y <name>` is a
 *     no-op and the lane proceeds. (Measured on the new trixie image:
 *     `postgresql-18` is baked in at 18.4-1.pgdg13+1 by rtech-infra PR #445.)
 *   - If it is absent, apt resolves the candidate for the RUNNING distro and
 *     installs it. (Measured: `bubblewrap` is absent from the new image;
 *     candidate 0.11.0-2+deb13u1.)
 *
 * ## What is still pinned, and why it is the part that mattered
 *
 * `postgresql-18` keeps its MAJOR version in the package name, and that is
 * load-bearing: the receipt must attest the PostgreSQL major that
 * Development actually runs. It previously attested 15 — a version running
 * nowhere else — purely because that was what the base image happened to
 * carry, and an attestation against a version production does not run is a gate
 * that can pass while production breaks. The major version is selected by the
 * NAME (`postgresql-18`), so it survives this change intact. What is dropped is
 * only the Debian packaging revision, which never encoded anything a reviewer
 * chose.
 *
 * Adding a `=version` suffix to any constant here reintroduces the defect.
 * `tests/runner/packages.test.ts` fails on a distro-release string.
 */

/**
 * Bubblewrap. Every lane runs candidate code ONLY inside a `bwrap` sandbox, so
 * each lane ensures this package is present before launching one. Absent from
 * the trixie golden image as of 2026-08-02.
 */
export const RUNNER_BUBBLEWRAP_PACKAGE = "bubblewrap" as const;

/**
 * The PostgreSQL server binaries the pre-push lane needs for its isolated
 * in-sandbox cluster. The MAJOR version in this name is the Development-wide
 * standard and is deliberately NOT the distro default; the golden image
 * adds the PGDG repository to supply it. Baked into the trixie golden image.
 */
export const RUNNER_POSTGRESQL_PACKAGE = "postgresql-18" as const;
