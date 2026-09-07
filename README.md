# Secure Event Ticketing Platform

Projektni zadatak za kolegij **Uvod u DevOps – DevSecOps**, Sveučilište Algebra Bernays.

Aplikacija za prodaju ulaznica provedena kroz cijeli DevOps ciklus: kontejnerizacija,
lokalno razvojno okruženje (Docker Compose), automatizirana izgradnja sa sigurnosnim
skeniranjem (GitHub Actions + Trivy) i produkcijska orkestracija (Kubernetes).

## Arhitektura

| Servis | Tehnologija | Uloga |
|---|---|---|
| `frontend` | Node / Express, port 3000 | Web sučelje za pregled evenata i kupnju karata |
| `api` | Node / Express, port 8080 | REST API: eventi, narudžbe, health provjere; stavlja narudžbe u queue |
| `worker` | Node | Čita narudžbe iz Redis queuea i upisuje ih u bazu |
| `postgres` | PostgreSQL 16 | Trajna pohrana narudžbi (tablica `ticket_orders`) |
| `redis` | Redis 7 | Queue između API-ja i workera |

Tok kupnje karte:

```
preglednik → frontend:3000
preglednik → api:8080 ──LPUSH──► redis:6379 ──BRPOP──► worker ──INSERT──► postgres:5432
                  └────────────────── SELECT ──────────────────────────────┘
```

API korisniku odgovori odmah (`202 Accepted`), a worker narudžbu obradi u pozadini.
To razdvajanje sinkronog od asinkronog dijela znači da nagli val kupnji puni queue,
a ne ruši API.

Detaljno obrazloženje odabira (uključujući usporedbu kontejnera i virtualnih mašina):
[`docs/architecture.md`](docs/architecture.md).

## Preduvjeti

- Docker Desktop s Docker Compose v2.22+ (ili Podman s `podman compose`)
- Slobodni portovi 3000 i 8080

## Pokretanje

1. Kopiraj predložak varijabli okoline u stvarni `.env`:

   ```bash
   cp .env.example .env        # PowerShell: Copy-Item .env.example .env
   ```

   Datoteka `.env` je u `.gitignore` i nikad ne ulazi u repozitorij.

2. Podigni cijeli stack jednom naredbom:

   ```bash
   docker compose up --build -d
   ```

   Compose poštuje `depends_on` s uvjetom `service_healthy`: postgres i redis se
   prvo dignu kao zdravi, tek onda kreću api, worker i frontend.

3. Provjeri stanje:

   ```bash
   docker compose ps
   ```

   Svih pet servisa mora biti `running`; postgres, redis i api uz to `(healthy)`.

4. Razvoj s hot-reloadom (izmjena koda se odmah primijeni):

   ```bash
   docker compose watch
   ```

## Zaustavljanje

```bash
docker compose down        # zaustavi i ukloni kontejnere; podaci u bazi ostaju
docker compose down -v     # dodatno obriši volume, tj. potpuni reset baze
```

## Validacija funkcionalnosti

```bash
# 1. Je li API živ i spreman (readyz provjerava i bazu i redis)
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz

# 2. Popis dostupnih evenata
curl http://localhost:8080/events

# 3. Kupnja karte - vraća 202 i orderId
curl -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'

# 4. Provjera da je worker narudžbu obradio - status mora biti "processed"
curl http://localhost:8080/tickets/orders
```

Korak 4 je stvarni dokaz da radi cijeli lanac `api → redis → worker → postgres`.
Web sučelje: <http://localhost:3000>.

### Napomena za Windows / PowerShell

U PowerShellu je `curl` alias za `Invoke-WebRequest`, pa treba pisati `curl.exe`.
Uz to PowerShell obrađuje dvostruke navodnike prije nego ih proslijedi programu,
zbog čega JSON tijelo zahtjeva stigne izobličeno i API vrati `SyntaxError`.
Rješenje je JSON staviti u varijablu s jednostrukim navodnicima:

```powershell
$body = '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
curl.exe -X POST http://localhost:8080/tickets/purchase -H "Content-Type: application/json" -d $body
```

ili koristiti ugrađeni cmdlet:

```powershell
Invoke-RestMethod -Uri http://localhost:8080/tickets/purchase -Method Post `
  -ContentType "application/json" `
  -Body '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
```

## Podman ekvivalenti

Projekt je izveden s Dockerom, no zadatak jednako dopušta Podman. Naredbe su
gotovo istovjetne jer Podman implementira isto sučelje:

| Docker | Podman |
|---|---|
| `docker build -t ime:oznaka ./api` | `podman build -t ime:oznaka ./api` |
| `docker run --rm ime:oznaka` | `podman run --rm ime:oznaka` |
| `docker compose up --build -d` | `podman compose up --build -d` |
| `docker compose ps` / `logs` / `down` | `podman compose ps` / `logs` / `down` |
| `docker images` | `podman images` |
| `docker push ghcr.io/...` | `podman push ghcr.io/...` |

Datoteka `Dockerfile` kod Podmana se uobičajeno zove `Containerfile`, ali Podman
prihvaća oba imena bez izmjena u sadržaju. Bitna razlika je arhitekturna: Podman
nema pozadinski servis (daemon) i kontejnere može pokretati bez administratorskih
ovlasti, što je sigurnosna prednost — iako je i ovdje proces unutar kontejnera
namjerno postavljen da ne vrti kao root.

## Sigurnosne mjere

- Multi-stage build i minimalna `node:22-alpine` runtime slika (~58 MB)
- Kontejneri vrte kao non-root korisnik `appuser`
- `.dockerignore` sprječava da `node_modules` i `.env` uđu u sliku
- Postgres i Redis nisu izloženi izvan Compose mreže
- Lozinke samo u `.env` / Kubernetes Secretu, nikad u kodu
- Trivy skeniranje slika kao quality gate u CI pipelineu

## Dokumentacija

- [`docs/architecture.md`](docs/architecture.md) – arhitektura, kontejneri vs. VM, komunikacija servisa
- [`docs/deployment.md`](docs/deployment.md) – deployment na Kubernetes, korak po korak
- [`docs/security/image-scan-report.md`](docs/security/image-scan-report.md) – nalazi skeniranja i korektivne mjere
- [`docs/runbook.md`](docs/runbook.md) – troubleshooting: pad baze, loš image tag, neispravan secret

## Struktura repozitorija

```
api/          frontend/     worker/        # izvorni kod + Dockerfile po servisu
infra/        postgres/init.sql            # inicijalizacija sheme baze
k8s/                                       # Kubernetes manifesti (2. dio)
docs/                                      # dokumentacija i sigurnosni izvještaji
.github/workflows/ci.yaml                  # CI pipeline: build → scan → push
compose.yaml                               # lokalno razvojno okruženje (1. dio)
.env.example                               # predložak varijabli okoline
```
