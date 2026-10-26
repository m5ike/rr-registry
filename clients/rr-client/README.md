# @m5ike/rr-client

Klientská knihovna pro správcovské API **RR Registry** (`/api/v1`).
Je generována při sestavení (`make build`) ze specifikace `api/spec.json`, takže vždy odpovídá serveru.
Funguje v Node.js ≥ 18 i v prohlížeči (UMD, globální `RRClient`). Maintainer: **m5ike**.

## Instalace

```bash
npm install @m5ike/rr-client --registry http://localhost:4873/
```

## Použití

```js
const RRClient = require('@m5ike/rr-client');
const rr = new RRClient({ baseUrl: 'http://localhost:4873', token: process.env.RR_TOKEN });

await rr.status();
await rr.listRepos();
await rr.createRepo({ name: 'internal', type: 'npm', description: 'Interní balíčky' });
await rr.listPackages('internal', { q: 'utils' });
await rr.setDistTag('internal', '@corp/utils', 'beta', { version: '2.0.0-beta.1' });
await rr.uploadPackage('internal', fs.readFileSync('pkg-1.0.0.tgz'));
await rr.createRoute({ name: 'corp', when: 'always', pattern: '/@corp/', target: 'https://npm.corp.example' });
await rr.purgeCache({ expired: 1 });

// přihlášení jménem a heslem (uloží token do klienta)
const anon = new RRClient({ baseUrl: 'http://localhost:4873' });
await anon.signIn('admin', 'heslo');
```

V prohlížeči:

```html
<script src="http://localhost:4873/static/rr-client.js"></script>
<script>
  const rr = new RRClient({ baseUrl: 'http://localhost:4873', token: '...' });
  rr.listRepos().then(console.log);
</script>
```

Konvence volání: `client.<operace>(parametryCesty..., [body | data], [query])`.
Chyby jsou vyhozeny jako `RRClient.RRError` (`status`, `message`, `body`).
Seznam všech operací: `RRClient.operations` nebo `docs/API.md` v repozitáři projektu.
