# Dnevnik rada na projektu

Kronološki zapis onoga što je rađeno, što se pritom pokvarilo i kako je riješeno.
Ovaj dnevnik je izvor iz kojeg su pisani README, ostala dokumentacija i završni
izvještaj — zabilježeni su stvarni koraci i stvarni ispisi, ne naknadna rekonstrukcija.

---

## 1. Priprema okruženja

Preuzet je izvorni kod aplikacije iz repozitorija
`matej-basic/devops-project-app`. Repozitorij sadrži isključivo izvorni kod pet
servisa i SQL skriptu za inicijalizaciju baze — bez ijedne datoteke za
kontejnerizaciju, orkestraciju ili automatizaciju. Sve to predmet je ovog projekta.

Instalirani alati (Windows, kroz `winget`): Git, Docker Desktop, kubectl,
minikube, Visual Studio Code.

### Incident 1 — Docker daemon nedostupan

**Simptom.** Nakon instalacije, `docker build` javlja:

```
ERROR: failed to connect to the docker API at npipe:////./pipe/docker_engine;
check if the path is correct and if the daemon is running
```

**Dijagnostika.** `docker version` ispisuje samo odjeljak `Client:`, dok
`Server:` izostaje. To znači da je klijentski alat instaliran, ali motor
(daemon) ne radi — klijent nema s čim komunicirati.

**Uzrok.** Docker Desktop se nakon instalacije ne pokreće automatski.

**Rješenje.** Ručno pokretanje Docker Desktopa.

### Incident 2 — WSL nije instaliran

**Simptom.** Docker Desktop pri pokretanju javlja `Docker Desktop - WSL not
installed`, a poruka o grešci mijenja se u `npipe:////./pipe/dockerDesktopLinuxEngine`.

**Dijagnostika.** Promjena imena pipea pokazuje da Docker Desktop sada traži
svoj Linux motor, dakle napredovali smo korak dalje. Docker na Windowsu Linux
kontejnere pokreće unutar WSL2 podsustava.

**Uzrok.** WSL2 nije bio instaliran na sustavu.

**Rješenje.** `wsl --install` u PowerShellu s administratorskim ovlastima,
zatim ponovno pokretanje računala. Nakon toga Docker Desktop uredno kreće i
`docker version` ispisuje i `Client:` i `Server:`.

---

## 2. Kontejnerizacija servisa

Za `api`, `frontend` i `worker` napisani su multi-stage Dockerfilei:

- **builder stage** instalira ovisnosti (`npm install --omit=dev`),
- **runtime stage** je čista `node:22-alpine` slika u koju se kopira samo rezultat.

Primijenjene odluke i njihova obrazloženja:

| Odluka | Razlog |
|---|---|
| `COPY package*.json` prije `COPY src/` | Docker cachira slojeve; izmjena koda ne pokreće ponovnu instalaciju ovisnosti |
| `--omit=dev` | U produkcijskoj slici nema razvojnih alata (nodemon) |
| `addgroup`/`adduser` + `USER appuser` | Proces ne vrti kao root |
| Bez `chown` na kopiranim datotekama | Datoteke ostaju u vlasništvu roota, aplikacija ih samo čita i ne može prepisati vlastiti kod |
| Exec forma `CMD ["node", ...]` | Proces dobiva PID 1 i uredno prima SIGTERM za graceful shutdown |
| `.dockerignore` | `node_modules` i `.env` ne ulaze u build context |

Rezultat prve izgradnje:

```
IMAGE                    ID             DISK USAGE   CONTENT SIZE
ticketing-api:dev        fc14f3dbad81        244MB         58.8MB
ticketing-frontend:dev   4b701651b6cc        237MB         58.5MB
ticketing-worker:dev     d983f6ca1b33        238MB         58.1MB
```

U drugom i trećem buildu pojavljuju se `CACHED` slojevi, što potvrđuje da
redoslijed naredbi u Dockerfileu postiže željeni učinak.

---

## 3. Lokalno razvojno okruženje (Compose)

Napisan je `compose.yaml` sa svih pet servisa. Ključne odluke:

- `depends_on` s uvjetom **`service_healthy`**, a ne pukim `service_started`.
  PostgreSQL otvori port nekoliko sekundi prije nego je spreman primati upite;
  bez healthchecka bi se api pokušao spojiti prerano i pao na startu.
- **Imenovani volume** `postgres_data` za perzistenciju baze.
- **Hot-reload** kroz `develop.watch` s akcijom `sync+restart`. Puki `sync` ne bi
  bio dovoljan jer Node sam ne prati promjene datoteka — kod bi se prenio, a stari
  proces bi i dalje izvršavao staru verziju. Promjena `package.json`-a pokreće
  `rebuild`, jer nova ovisnost zahtijeva novu sliku.
- `API_BASE_URL` postavljen na `http://localhost:8080`, **ne** na `http://api:8080`.
  Tu adresu poziva preglednik korisnika, koji ime `api` iz Compose mreže ne može
  razriješiti.
- PostgreSQL i Redis nemaju objavljene portove prema hostu — dostupni su samo
  unutar Compose mreže.

Provjera nakon pokretanja: svih pet kontejnera u stanju `running`, a postgres,
redis i api uz to `(healthy)`.

### Incident 3 — PowerShell izobličuje JSON

**Simptom.** `POST /tickets/purchase` vraća HTML stranicu s greškom
`SyntaxError: Expected property name or '}' in JSON at position 1`.

**Dijagnostika.** U ispisu se vidi da je tijelo zahtjeva stiglo kao
`eventId\:\evt-1001\,\customerEmail\:...` — dakle JSON je izobličen prije nego
je uopće napustio ljusku. Sami `/healthz` i `/readyz` rade ispravno, što
isključuje problem s aplikacijom.

**Uzrok.** PowerShell obrađuje dvostruke navodnike prije nego argumente
proslijedi programu.

**Rješenje.** JSON se stavlja u varijablu s jednostrukim navodnicima, ili se
koristi ugrađeni cmdlet `Invoke-RestMethod`. Postupak je dokumentiran u README-u.

### Incident 4 — narudžba se ne pojavljuje odmah

**Simptom.** Odmah nakon uspješne kupnje, `GET /tickets/orders` vraća prazan niz.

**Dijagnostika.**

```
$ docker compose logs worker --tail 30
worker-1  | Worker started and waiting for jobs...
worker-1  | Order processed

$ docker compose exec redis redis-cli LLEN ticket_orders
(integer) 0
```

Worker je poruku obradio, a queue je prazan — dakle sustav radi ispravno.

**Uzrok.** Nije riječ o kvaru. Obrada je **asinkrona**: API vraća `202 Accepted`
čim narudžbu stavi u queue, a worker je obrađuje kratko nakon toga. Upit
izvršen milisekundu kasnije zatekne bazu prije upisa.

**Zaključak.** Odgovor API-ja ne jamči da je posao dovršen, nego samo da je
preuzet. Ovo je svjesna posljedica arhitekture s queueom, a ne nedostatak — u
zamjenu se dobiva otpornost na nagle valove prometa. Ista spoznaja oblikovala je
i CI smoke test, koji rezultat provjerava u petlji, i kasnije odluku da worker
nema HTTP readiness probu.

Konačna potvrda cijelog lanca `api → redis → worker → postgres`:

```
order_id                             event_id customer_email      quantity status
56469674-8eb7-4c8c-aed7-63ba78edf7f4 evt-1001 student@example.com        2 processed
```

---

## 4. CI/CD pipeline

Napisan je GitHub Actions workflow s tri povezana koraka:

1. `test` — instalacija ovisnosti, provjera sintakse svake `.js` datoteke, `npm audit`.
2. `smoke-test` — podizanje cijelog stacka kroz Compose i stvarna kupnja karte,
   s provjerom u petlji zbog asinkrone obrade.
3. `build-scan-push` — izgradnja slika, Trivy sigurnosna brana, objava na GHCR.

Objava se nalazi iza brane, pa slika koja ne prođe provjeru nikad ne dođe do registryja.

### Incident 5 — brana zaustavila objavu (CVE-2026-59873)

Prvo pokretanje pipelinea (commit `1690f83`) završilo je neuspjehom na sva tri
`build & scan` joba, dok su `test` i `smoke-test` prošli.

Trivy je prijavio **CVE-2026-59873 (CRITICAL)** u paketu `tar` 7.5.11, uz
dostupan popravak u 7.5.19. Paketi operacijskog sustava i ovisnosti aplikacije
imali su 0 nalaza — ranjivost dolazi iz npm CLI-ja ugrađenog u baznu sliku.

Korektivna mjera bila je uklanjanje npm-a iz runtime slike, jer aplikaciji u
radu nije potreban. Nakon toga je pokretanje #2 (commit `d6059f4`) prošlo u
cijelosti i slike su objavljene.

Detaljna analiza: [`docs/security/image-scan-report.md`](security/image-scan-report.md).

**Napomena.** Ovaj incident nije kvar pipelinea nego dokaz da brana radi:
slika s kritičnom ranjivošću zaustavljena je prije objave. Zadržani su
snimci i neuspješnog i uspješnog pokretanja.

### Mjerljiv učinak automatizacije

| Postupak | Ručno | Kroz pipeline |
|---|---|---|
| Izgradnja tri slike, provjera koda, e2e test, skeniranje i objava | oko 15–20 min uz nadzor | 3 min 32 s bez nadzora |

Uz uštedu vremena, automatizirani postupak je i **reproducibilan**: izvodi se
identično na svakom commitu, neovisno o tome tko ga pokreće i s kojeg računala.

---

## 5. Produkcijsko okruženje (Kubernetes / minikube)

Klaster je podignut kroz `minikube start` uz uključen `ingress` addon. Slike su
građene lokalno i učitane u klaster (`minikube image load`), jer je repozitorij
privatan pa bi dohvat sa GHCR-a tražio i `imagePullSecret`.

Napisano je deset manifesta u `k8s/`, imenovanih s brojčanim prefiksom kako bi
`kubectl apply -f k8s/` primijenio namespace i konfiguraciju prije servisa koji
o njima ovise.

Pri prijelazu na Kubernetes bilo je potrebno promijeniti i Dockerfile: korisnik
je dobio **eksplicitan numerički UID (10001)** umjesto samo imena. Kubernetes ne
može utvrditi je li korisnik zadan imenom root ili ne, pa postavka
`runAsNonRoot: true` radi jedino kad je UID poznat broj.

Svih sedam podova podiglo se iz prvog pokušaja, bez restarta, unatoč strogim
sigurnosnim postavkama (`runAsNonRoot`, `readOnlyRootFilesystem`,
`capabilities: drop ALL`, `seccompProfile: RuntimeDefault`).

Provjera kroz Ingress potvrdila je cijeli lanac:

```
order_id                             event_id customer_email  quantity status
89b79c7c-af9c-4a7e-9d3d-89eae7bb069a evt-1002 k8s@example.com        3 processed
```

### Incident 6 — gubitak zahtjeva tijekom rolling updatea

**Kako je otkriven.** Kako bi se tvrdnja "isporuka bez prekida rada" mogla
dokazati, a ne samo napisati, tijekom zamjene verzije pokrenuto je mjerenje koje
svakih 500 ms poziva `/healthz` i bilježi svaki neuspjeh. API je pritom
prilagođen tako da u odgovoru vraća oznaku verzije utisnutu u sliku pri gradnji.

**Simptom.** Mjerenje pri prijelazu s `v1` na `v2`:

```
v1
v1
...
GRESKA
GRESKA
v2
v1
v2
v2
...
```

Dva zahtjeva nisu dobila odgovor. (Pojava jednog `v1` među `v2`-ovima nije
greška — dok obje replike postoje, Service promet dijeli između njih.)

**Analiza uzroka.** Pri gašenju poda dvije se stvari događaju istodobno, a ne
redom: pod dobiva `SIGTERM`, a njegova se adresa uklanja iz popisa odredišta
Servicea i Ingressa. Uklanjanje adrese nije trenutno jer se mora proširiti kroz
klaster. U tom kratkom prozoru Ingress još šalje zahtjeve podu koji već umire.

Aplikacija je taj problem pogoršavala: na `SIGTERM` je odmah zatvarala vezu
prema bazi i queueu i izlazila, ne dovršivši zahtjeve koji su bili u tijeku.

**Korektivne mjere.**

1. `preStop` hook (`sleep 5`) na api i frontend podovima — pod prije primanja
   `SIGTERM` još nekoliko sekundi normalno posluživa, a klaster u međuvremenu
   ukloni njegovu adresu iz odredišta.
2. Graceful shutdown u `api/src/server.js` — na `SIGTERM` se prvo poziva
   `server.close()` (prestaje primanje novih veza, dovršavaju se započete), pa
   se tek onda zatvaraju baza i queue.
3. `terminationGracePeriodSeconds: 30`, da oba koraka stignu uredno završiti.

**Validacija.** Isto mjerenje ponovljeno je na `kubectl rollout restart`, gdje i
pod koji odlazi i onaj koji dolazi imaju oba popravka. Rezultat: **60 uzastopnih
uspješnih odgovora, nijedna greška**, iako su u međuvremenu zamijenjena oba poda.

| Mjerenje | Zamjena podova | Neuspjeli zahtjevi |
|---|---|---|
| Prije popravka (v1 → v2) | da | 2 |
| Nakon popravka (rollout restart) | da | 0 |

**Pouka.** Tvrdnja o isporuci bez prekida rada nije posljedica same upotrebe
Kubernetesa. Potrebni su readiness probe, `maxUnavailable: 0`, `preStop` hook i
graceful shutdown u samoj aplikaciji — i tek mjerenje pokazuje radi li to stvarno.

### Sporedne poteškoće u radu

- **`kubectl port-forward` se prekida.** Tunel prema Ingress kontroleru povremeno
  pada i ne obnavlja se sam, što se u mjerenju pokazivalo kao niz lažnih grešaka.
  Riješeno pokretanjem u petlji koja ga automatski ponovno diže.
- **Zavaravajući `CACHED` u Docker buildu.** Nakon izmjene izvornog koda build je
  korak `COPY src/` prikazao kao `CACHED`. Provjera sadržaja slike
  (`docker run --rm ticketing-api:v3 cat /app/src/server.js`) potvrdila je da je
  nova verzija ipak ušla u sliku — prikaz se odnosio na već izgrađen sloj s istim
  sadržajem. Pouka: stanje slike se provjerava u samoj slici, ne u ispisu builda.
