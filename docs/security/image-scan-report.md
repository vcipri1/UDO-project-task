# Sigurnosno izvješće skeniranja kontejnerskih slika

Alat: **Trivy** (aquasecurity/trivy-action), pokrenut automatski u CI pipelineu
(`.github/workflows/ci.yaml`) nad svakom izgrađenom slikom.

## Gdje se skeniranje događa u procesu

Slike se u pipelineu grade s `push: false, load: true` — namjerno se učitavaju
samo u lokalni Docker daemon runnera, a **ne** odmah na registry. Tek nakon toga
Trivy skenira sliku. Korak objave na GHCR nalazi se *iza* skeniranja, pa slika
koja ne prođe provjeru nikad ne dođe do registryja.

Skeniranje se izvodi u dva prolaza:

| Prolaz | Severity | `exit-code` | Svrha |
|---|---|---|---|
| Sigurnosna brana | CRITICAL | `1` | Ruši build i sprječava objavu |
| Izvještaj (SARIF) | sve | `0` | Evidencija svih nalaza, sprema se kao artefakt |

Drugi prolaz ima `if: always()` kako bi se nalazi zabilježili i onda kada je
brana pala — inače bismo ostali bez dokaza upravo u trenutku kad nam najviše treba.

## Nalaz 1 — CVE-2026-59873 (CRITICAL)

**Otkriven:** CI pokretanje #1, commit `1690f83`, 7. rujna 2026.
**Ishod:** brana je zaustavila objavu za sva tri servisa (api, frontend, worker).

| Stavka | Vrijednost |
|---|---|
| Paket | `tar` |
| Ranjivost | CVE-2026-59873 |
| Severity | CRITICAL |
| Instalirana verzija | 7.5.11 |
| Verzija s popravkom | 7.5.19 |
| Opis | node-tar: uskraćivanje usluge (DoS) preko posebno oblikovane gzip "bombe" |
| Lokacija u slici | `/usr/local/lib/node_modules/npm/node_modules/tar` |

### Analiza uzroka

Skeniranje je pokazalo da su **ostale mete čiste**:

- paketi operacijskog sustava (`alpine 3.24.1`) — 0 ranjivosti,
- ovisnosti aplikacije (`/app/node_modules`: express, pg, redis, uuid, dotenv) — 0 ranjivosti.

Ranjivi `tar` ne dolazi iz naših ovisnosti nego iz **npm CLI-ja koji je ugrađen u
baznu sliku `node:22-alpine`**. Ažuriranje `package.json`-a stoga ne bi promijenilo
ništa — paket nije naša ovisnost.

### Razmotrene opcije

1. **Iznimka u `.trivyignore`.** Odbačeno: ranjivost bi ostala u objavljenoj slici,
   a brana bi izgubila smisao.
2. **Čekanje nove bazne slike.** Odbačeno kao jedino rješenje: ne ovisi o nama i
   ostavlja projekt blokiranim na neodređeno vrijeme.
3. **Uklanjanje npm-a iz runtime slike.** Odabrano.

### Provedena korektivna mjera

U `runtime` stage svakog Dockerfilea dodan je korak:

```dockerfile
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx
```

Obrazloženje: kontejner se pokreće naredbom `node src/server.js` i npm mu u radu
nije potreban — bio je potreban isključivo u `builder` stageu, koji ionako ne
završava u finalnoj slici. Uklanjanjem npm-a ranjivi paket nestaje iz objavljene
slike, a napadna površina se dodatno smanjuje (manje izvršnih datoteka koje
napadač može iskoristiti).

Ovo je primjena principa **minimalne runtime slike**: u produkcijskoj slici ne
smije biti alata koji aplikaciji nisu potrebni za rad.

### Validacija

Lokalna provjera da je mjera djelovala, a aplikacija ostala ispravna:

```
$ docker run --rm ticketing-api:dev node --version
v22.23.2

$ docker run --rm ticketing-api:dev npm --version
Error: Cannot find module '/app/npm'
```

Druga naredba dokazuje da npm više ne postoji: `ENTRYPOINT` bazne slike naredbu
koju ne prepozna kao izvršnu datoteku pokušava pokrenuti kao Node skriptu, pa
`node` traži nepostojeću datoteku `/app/npm`.

**Ponovno skeniranje:** CI pokretanje #2, commit `d6059f4` — sva tri servisa
prošla branu, slike objavljene na GHCR. Ukupno trajanje pipelinea 3 min 32 s.

## Trenutno stanje

| Slika | OS paketi | Ovisnosti aplikacije | CRITICAL | Status |
|---|---|---|---|---|
| `ticketing-api` | 0 | 0 | 0 | objavljena |
| `ticketing-frontend` | 0 | 0 | 0 | objavljena |
| `ticketing-worker` | 0 | 0 | 0 | objavljena |

## Politika objave slika

- Slika se objavljuje **samo** ako prođe branu na CRITICAL ranjivostima.
- Objava se izvršava samo na `push` u granu `main`; kod pull requesta pipeline
  gradi i skenira, ali ne objavljuje.
- Svaka se slika označava s **dvije oznake**:
  - `:<commit-sha>` — nepromjenjiva oznaka koja točno određuje koji je kod u slici,
  - `:latest` — pokretna oznaka za pogodnost.
  U produkciji se referencira SHA oznaka, jer `latest` s vremenom pokazuje na
  nešto drugo i onemogućuje reproducibilan deployment.
- Prijava na registry koristi ugrađeni `GITHUB_TOKEN`; u repozitoriju nema
  nijedne hardkodirane lozinke ni ručno kreiranog tokena.
- SARIF izvještaji svih nalaza čuvaju se 30 dana kao artefakti pokretanja.

## Napomena o HIGH razini

Brana je namjerno postavljena na CRITICAL, ne na HIGH. Razlog je praktičan:
ranjivosti razine HIGH često dolaze iz baznih slika i nemaju dostupan popravak,
pa bi blokiranje na toj razini zaustavilo isporuku bez sigurnosne koristi.
Takvi se nalazi i dalje bilježe u SARIF izvještaju i pregledavaju, ali ne
zaustavljaju pipeline. Uz to je uključena opcija `ignore-unfixed: true`, koja
zanemaruje ranjivosti za koje popravak još ne postoji.
