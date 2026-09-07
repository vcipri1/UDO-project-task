# Arhitektura i obrazloženje odluka

Dokument objašnjava **zašto** je sustav ovako građen: zašto kontejneri umjesto
virtualnih mašina, zašto baš pet servisa i kako oni međusobno komuniciraju.

---

## 1. Kontejneri ili virtualne mašine

Aplikaciju čini pet manjih procesa koje treba moći pokrenuti identično na
razvojnom računalu, u CI okruženju i u produkciji. Odabran je kontejnerski
pristup. Odluka nije samorazumljiva, pa slijedi usporedba.

### Tehnička razlika

Virtualna mašina virtualizira **hardver**: hipervizor emulira sklopovlje, na
njemu se pokreće cijeli gostujući operacijski sustav s vlastitim kernelom.
Kontejner virtualizira **procesni prostor**: svi kontejneri dijele kernel
domaćina, a izolirani su kroz mehanizme `namespaces` (odvojen pogled na procese,
mrežu i datotečni sustav) i `cgroups` (ograničenje resursa).

Posljedica je razlika u redu veličine, a ne u postotcima.

| Svojstvo | Virtualna mašina | Kontejner |
|---|---|---|
| Sadrži | Cijeli OS s kernelom | Samo proces i njegove ovisnosti |
| Veličina | Gigabajti | Deseci megabajta (naše slike: 58 MB) |
| Pokretanje | Desetci sekundi do minute | Sekunda |
| Gustoća na jednom hostu | Jedinice do desetci | Stotine |
| Izolacija | Jaka (odvojeni kerneli) | Slabija (dijeljeni kernel) |
| Opis okruženja | Ručna konfiguracija ili posebni alati | `Dockerfile`, verzioniran uz kod |

### Zašto su kontejneri odabrani

**Reproducibilnost.** `Dockerfile` je kod i živi u istom repozitoriju kao
aplikacija. Ista slika koja je izgrađena u CI-ju pokreće se i u produkciji, bit
po bit. Kod virtualnih mašina se okruženje opisuje odvojenim alatima, a razlike
između razvojnog i produkcijskog okruženja lako se uvuku neopaženo.

**Brzina isporuke.** Cijeli CI ciklus — provjera koda, podizanje sustava,
end-to-end test, skeniranje ranjivosti i objava tri slike — traje **3 min 32 s**.
S virtualnim mašinama bi samo podizanje okruženja trajalo dulje od toga.

**Gustoća.** Pet servisa vrti se na jednom razvojnom računalu bez zamjetnog
opterećenja. Pet virtualnih mašina s vlastitim kernelima tražilo bi višestruko
više memorije.

**Orkestracija.** Kubernetes je građen oko kontejnera. Samostalno oporavljanje,
rolling update i horizontalno skaliranje pretpostavljaju jedinicu koja se
pokreće u sekundi. S minutnim pokretanjem ti mehanizmi gube smisao.

### Cijena odluke i kako je pokrivena

Glavni nedostatak je slabija izolacija: kontejneri dijele kernel domaćina, pa
ranjivost u kernelu pogađa sve odjednom. Ta se cijena ne može ukloniti, ali se
može smanjiti — i upravo to rade sigurnosne mjere u projektu:

| Rizik zbog dijeljenog kernela | Protumjera | Gdje |
|---|---|---|
| Proces s root ovlastima nakon proboja | `USER 10001`, `runAsNonRoot: true` | Dockerfile, manifesti |
| Stjecanje dodatnih ovlasti | `allowPrivilegeEscalation: false`, `capabilities: drop ALL` | manifesti |
| Zloupotreba sistemskih poziva prema kernelu | `seccompProfile: RuntimeDefault` | manifesti |
| Izmjena koda unutar kontejnera | `readOnlyRootFilesystem: true` | manifesti |
| Ranjivosti u paketima slike | Trivy kao brana u CI-ju, minimalna Alpine baza, uklonjen npm | pipeline, Dockerfile |
| Bočno kretanje kroz mrežu | NetworkPolicy: default deny + eksplicitna dopuštenja | manifesti |
| Zlouporaba Kubernetes API-ja | ServiceAccount bez montiranog tokena | manifesti |

### Kada bi virtualna mašina bila ispravan izbor

Iskrenosti radi: da je zahtjev bio izvršavanje nepovjerljivog tuđeg koda, ili
rad s različitim kernelima, ili regulatorna obveza potpune izolacije po
korisniku — virtualna mašina bi bila ispravan izbor. Ovdje ti zahtjevi ne
postoje, a svi ostali kriteriji govore u prilog kontejnerima.

---

## 2. Servisi i njihove uloge

| Servis | Tehnologija | Uloga | Stanje |
|---|---|---|---|
| `frontend` | Node / Express, :3000 | Posluživanje web sučelja i statičkih datoteka | bez stanja |
| `api` | Node / Express, :8080 | REST sučelje: eventi, primanje narudžbi, health provjere | bez stanja |
| `worker` | Node | Obrada narudžbi iz queuea i upis u bazu | bez stanja |
| `postgres` | PostgreSQL 16, :5432 | Trajna pohrana narudžbi | sa stanjem |
| `redis` | Redis 7, :6379 | Queue između api-ja i workera | prolazno stanje |

### Zašto baš ova podjela

Granice servisa prate **granice odgovornosti**, a ne proizvoljnu podjelu koda:

- **Prikaz je odvojen od logike.** Frontend se mijenja iz posve drugih razloga
  nego API, pa se i isporučuje neovisno.
- **Ulaz je odvojen od obrade.** Ovo je najvažnija odluka u sustavu i objašnjena
  je zasebno niže.
- **Pohrana je odvojena od aplikacije.** PostgreSQL i Redis su gotove službene
  slike. Vlastita slika baze značila bi trajno održavanje bez ikakve koristi.

### Ključna odluka: razdvajanje sinkronog od asinkronog

API na `POST /tickets/purchase` **ne upisuje narudžbu u bazu**. Stavlja je u
Redis queue i korisniku odmah vraća `202 Accepted`. Worker je zatim preuzima i
upisuje u PostgreSQL.

Razlog je otpornost na navalu prometa. Prodaja ulaznica ima izrazito neravnomjeran
promet: mjesecima ništa, pa nekoliko tisuća zahtjeva u minuti kad krene prodaja
za traženi događaj. Bez queuea taj val ide izravno na bazu i ruši je, a s njom i
cijelu aplikaciju. S queueom val puni Redis — operaciju u memoriji koja podnosi
red veličine više prometa — a worker ga obrađuje svojim tempom.

Nusprodukt te odluke je da **odgovor API-ja ne jamči da je posao dovršen**, nego
samo da je preuzet. To se pokazalo i u radu: upit izvršen milisekundu nakon
kupnje zatekne bazu prije upisa. To nije nedostatak nego svojstvo arhitekture, i
oblikovalo je dvije daljnje odluke — CI smoke test provjerava rezultat u petlji,
a worker nema HTTP readiness probu jer nije iza Servicea i ne prima promet.

Drugi nusprodukt: api i worker su **bez stanja**, pa se mogu replicirati bez
usklađivanja. Api zato u produkciji vrti u dvije replike.

---

## 3. Komunikacija između servisa

```
        korisnik
       (preglednik)
            │
            ▼
    ┌───────────────┐
    │    Ingress    │   jedina ulazna tocka izvana
    └───┬───────┬───┘
    /   │       │  /api
        ▼       ▼
  ┌──────────┐ ┌──────────┐
  │ frontend │ │   api    │  2 replike
  │  :3000   │ │  :8080   │
  └──────────┘ └────┬─────┘
                    │ LPUSH (narudzba)
                    ▼
              ┌──────────┐        ┌──────────┐
              │  redis   │◄───────│  worker  │
              │  :6379   │ BRPOP  │          │
              └──────────┘        └────┬─────┘
                    ▲                  │ INSERT
                    │                  ▼
                    │            ┌──────────┐
                    └────────────│ postgres │
                       SELECT    │  :5432   │
                      (iz api)   │   PVC    │
                                 └──────────┘
```

### Pronalaženje servisa

Servisi se ne pronalaze po IP adresama nego po imenima. U Composeu to rješava
ugrađeni DNS Compose mreže, u Kubernetesu `Service` objekti: `api` se spaja na
`postgres:5432`, neovisno o tome koji pod trenutno stoji iza tog imena i koliko
ih je. Zato zamjena poda ne traži nikakvu izmjenu konfiguracije.

### Jedna zamka koju vrijedi zabilježiti

Adresa API-ja za frontend **nije** interno ime servisa. Frontend preglednik
dobiva `apiBaseUrl` i poziva ga iz korisnikovog uređaja, koji ime `api` iz
klasterske mreže ne može razriješiti. Zato je vrijednost `http://localhost:8080`
u lokalnom razvoju, a `/api` u Kubernetesu — relativna putanja koju Ingress
proslijedi API servisu. Ovo je čest izvor grešaka kod prijelaza s Composea na
Kubernetes.

### Tko smije s kim razgovarati

U Composeu je ograničenje izvedeno objavom portova: samo `frontend` i `api`
imaju port objavljen prema domaćinu; `postgres` i `redis` dostupni su isključivo
unutar Compose mreže.

U Kubernetesu je isto pravilo izraženo eksplicitno, jer zadano svaki pod može
pričati sa svakim. NetworkPolicy prvo zabranjuje sav ulazni promet u namespaceu,
pa dopušta samo potrebno:

| Odredište | Dopušten izvor | Port |
|---|---|---|
| `postgres` | `api`, `worker` | 5432 |
| `redis` | `api`, `worker` | 6379 |
| `api` | Ingress kontroler | 8080 |
| `frontend` | Ingress kontroler | 3000 |

Praktična posljedica: probije li napadač frontend pod, iz njega ne može doći do
baze — ne zato što ne zna adresu, nego zato što ga mreža ne propušta.

---

## 4. Usklađenost s ciljevima projekta

| Cilj | Kako je postignut |
|---|---|
| Sigurna isporuka | Trivy kao brana koja ruši build prije objave; skeniranje se izvodi na slici učitanoj lokalno, prije nego ijedna verzija dođe do registryja |
| Upravljanje slikama | Multi-stage build, Alpine baza, non-root korisnik, uklonjen npm iz runtime slike, oznaka commit SHA-om uz `latest` |
| Orkestracija | Deploymenti s replikama, probe, resource limiti, PVC, Ingress, RBAC i NetworkPolicy |
| Observability | `/healthz` i `/readyz` kao izvor istine za liveness i readiness; `kubectl logs`, `describe` i `events` kao alati dijagnostike |
| Troubleshooting | Četiri izvedena incidentna scenarija sa stvarnim ispisima u `runbook.md` |
| Ubrzana isporuka | Cijeli ciklus automatiziran u 3 min 32 s, isti postupak na svakom commitu |

### Što bi se u pravoj produkciji radilo drukčije

Projekt je namjerno građen na minikubeu i s lokalno učitanim slikama. U pravom
produkcijskom okruženju razlikovalo bi se sljedeće:

- Slike bi se dohvaćale iz registryja po **commit SHA oznaci**, ne po `latest`,
  uz `imagePullSecret`.
- PostgreSQL ne bi vrtio kao običan Deployment, nego kao **StatefulSet** ili
  upravljana usluga, s replikacijom i automatiziranim sigurnosnim kopijama.
- Dodali bi se **HorizontalPodAutoscaler** i **PodDisruptionBudget**.
- Uvela bi se **centralizirana zbirka logova i metrika**; trenutno se stanje
  utvrđuje ručno kroz `kubectl`.
- Ingress bi imao **TLS** s automatskim obnavljanjem certifikata.
- Deployment bi se izvodio **GitOps pristupom** (Argo CD ili Flux), gdje je
  željeno stanje isključivo ono u gitu — čime nestaje i problem rollbacka koji
  razilazi klaster i repozitorij, opisan u runbooku.
