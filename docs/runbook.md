# Runbook — dijagnostika i otklanjanje kvarova

Priručnik za dežurnu osobu. Svaki scenarij je **stvarno izveden** na
minikube klasteru u namespaceu `ticketing`; navedeni ispisi su izvorni.

Sve naredbe pretpostavljaju `-n ticketing`. Za pristup aplikaciji izvana mora
biti otvoren tunel prema Ingress kontroleru:

```powershell
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80
```

---

## Opći postupak — redoslijed koji vrijedi uvijek

Prije bilo kakvog zahvata utvrdi **gdje** je kvar, idući izvana prema unutra:

| Korak | Naredba | Što odgovara |
|---|---|---|
| 1 | `kubectl get pods -n ticketing` | Vrte li podovi i jesu li `READY`? |
| 2 | `kubectl describe pod <pod> -n ticketing` | Zašto Kubernetes ne može dalje (odjeljak `Events`) |
| 3 | `kubectl logs <pod> -n ticketing` | Što je sama aplikacija rekla |
| 4 | `kubectl get events -n ticketing --sort-by=.lastTimestamp` | Kronologija svega u namespaceu |
| 5 | `curl http://localhost:8080/api/readyz` | Vidi li API bazu i queue |

**Ključna razlika između koraka 2 i 3.** `describe` govori što *Kubernetes* ne
može (nema slike, ne može montirati disk, probe ne prolazi). `logs` govori što je
*aplikacija* rekla prije nego je stala. Kvar zbog konfiguracije često ostavlja
uredan log, a vidi se samo u `describe` — vidi scenarij C.

**Razlika između `STATUS` i `READY`.** Pod može biti `Running` i `0/1` istodobno:
proces radi, ali readiness proba ne prolazi, pa Service ne šalje promet.
`RESTARTS` veći od nule znači da je liveness proba već obarala kontejner.

---

## Scenarij A — pad baze podataka

**Simptom.** Aplikacija vraća greške pri dohvaćanju narudžbi;
`/readyz` vraća `503` s porukom `not-ready`.

**Reprodukcija.**

```powershell
kubectl -n ticketing delete pod -l app=postgres
```

**Dijagnostika.**

```powershell
kubectl -n ticketing get pods -l app=postgres
kubectl -n ticketing logs -l app=api --tail=20
kubectl -n ticketing describe pvc postgres-data
```

**Uzrok.** Pod baze je nestao. Podovi su u Kubernetesu prolazni — nestanak poda
je očekivan događaj, ne iznimka.

**Očekivano ponašanje sustava.** Deployment ima `replicas: 1`, pa kontroler
odmah stvara zamjenski pod. `/readyz` u međuvremenu javlja da API nije spreman,
što je ispravno: bolje priznati nedostupnost nego lažno tvrditi da sve radi.

Izmjereno (upit svakih 500 ms):

```
ready              <- 15 uzoraka
NIJE SPREMAN       <- 22 uzorka  (~11 sekundi)
ready              <- oporavak bez ijedne naredbe
```

**Korektivna mjera.** Nikakva ručna intervencija nije potrebna — sustav se
oporavlja sam. Ako se pod ne digne, provjeri:

```powershell
kubectl -n ticketing describe pod -l app=postgres     # Events: nedostatak resursa? problem s diskom?
kubectl -n ticketing get pvc                          # je li PVC u stanju Bound?
kubectl -n ticketing get events --sort-by=.lastTimestamp
```

**Validacija.** Podaci moraju preživjeti, jer su na PVC-u, a ne u podu:

```powershell
Invoke-RestMethod http://localhost:8080/api/tickets/orders | Format-Table
```

Narudžba zabilježena prije rušenja bila je prisutna i nakon oporavka.

**Napomena.** Nakon ovog scenarija api podovi pokazuju `RESTARTS 1`. Kad baza
nestane, veza prema njoj puca i proces završi, pa ga Kubernetes restarta — što
je upravo ono što se od njega očekuje.

---

## Scenarij B — pogrešna oznaka slike (loš image tag)

**Simptom.** `kubectl rollout status` se ne dovršava; novi pod stoji u
`ImagePullBackOff`. Aplikacija pritom **normalno radi**.

**Reprodukcija.**

```powershell
kubectl -n ticketing set image deployment/api api=ticketing-api:v99
kubectl -n ticketing rollout status deployment/api --timeout=45s
```

```
Waiting for deployment "api" rollout to finish: 1 out of 2 new replicas have been updated...
error: timed out waiting for the condition
```

**Dijagnostika.**

```powershell
kubectl -n ticketing get pods -l app=api
```

```
NAME                   READY   STATUS             RESTARTS   AGE
api-58f558757c-7czlr   0/1     ImagePullBackOff   0          48s
api-5fccfd5798-6jwzm   1/1     Running            1          5m52s
api-5fccfd5798-qxvv7   1/1     Running            1          5m45s
```

```powershell
kubectl -n ticketing describe pod -l app=api | Select-String -Context 0,8 "Events:"
```

**Uzrok.** Slika `ticketing-api:v99` ne postoji ni lokalno u klasteru ni u
registryju, pa je Kubernetes ne može dohvatiti.

**Zašto korisnik ovo ne osjeti.** `maxUnavailable: 0` znači da nijedna stara
replika ne smije nestati prije nego nova prođe readiness provjeru. Nova nikad
neće, pa zamjena ostaje zaglavljena, a stare replike i dalje posluživaju.
Mjerenje tijekom cijelog neuspjelog deploya: **60 od 60 uspješnih zahtjeva, nula
grešaka.**

**Korektivna mjera.**

```powershell
kubectl -n ticketing rollout undo deployment/api
kubectl -n ticketing rollout status deployment/api
```

**Validacija.**

```powershell
Invoke-RestMethod http://localhost:8080/api/healthz
# status service version
# ok     api     v3
```

**Upozorenje uz rollback.** `kubectl` nakon `rollout undo` javlja:

> resource deployments/api was previously managed with 'kubectl apply'.
> Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration
> annotation, which may cause unexpected behavior on future 'kubectl apply' operations.

Rollback mijenja stanje u klasteru, ali ne i manifest u repozitoriju. Sljedeći
`kubectl apply` može zato vratiti upravo onu verziju koja je povučena. Nakon
svakog rollbacka manifest treba uskladiti sa stvarnim stanjem i to commitati.

**Prevencija.** Deployati sliku označenu commit SHA-om (`:<sha>`), koji CI
pipeline sam upisuje, umjesto ručno tipkane oznake.

---

## Scenarij C — neispravan secret

**Simptom.** Podovi se pokreću bez ijedne greške u logu, ali nikad ne postanu
`READY`. Zamjena verzije zapinje.

**Reprodukcija.**

```powershell
kubectl -n ticketing delete secret app-secret
kubectl -n ticketing create secret generic app-secret --from-literal=POSTGRES_PASSWORD='pogresna-lozinka'
kubectl -n ticketing rollout restart deployment/api
kubectl -n ticketing rollout status deployment/api --timeout=45s
```

**Dijagnostika.**

```powershell
kubectl -n ticketing get pods -l app=api
```

```
NAME                   READY   STATUS    RESTARTS   AGE
api-59cd69ddc9-nzr45   0/1     Running   0          48s     <- novi pod: radi, ali nije spreman
api-5fccfd5798-6jwzm   1/1     Running   1          9m16s   <- stari podovi i dalje posluzuju
api-5fccfd5798-qxvv7   1/1     Running   1          9m9s
```

```powershell
kubectl -n ticketing logs -l app=api --tail=15
```

```
API listening on port 8080 (verzija v3)
```

**Ovdje je zamka.** Log ne pokazuje ništa sumnjivo — aplikacija se uredno
pokrenula. Problem je isključivo u tome što readiness proba ne prolazi, a to se
vidi tek u događajima poda:

```powershell
kubectl -n ticketing describe pod <novi-pod> | Select-String -Context 0,8 "Events:"
# Warning  Unhealthy  ... Readiness probe failed: HTTP probe failed with statuscode: 503
```

Potvrda izravno iz poda:

```powershell
kubectl -n ticketing exec <novi-pod> -- wget -qO- http://localhost:8080/readyz
# {"status":"not-ready","error":"password authentication failed for user \"ticketing_user\""}
```

**Uzrok.** Lozinka u Secretu ne odgovara onoj kojom je baza inicijalizirana.
Bitno: `POSTGRES_PASSWORD` na već inicijaliziranoj bazi ne mijenja pohranjenu
lozinku, pa promjena Secreta razdvaja aplikaciju od baze.

**Korektivna mjera.**

```powershell
kubectl -n ticketing delete secret app-secret
kubectl -n ticketing create secret generic app-secret --from-literal=POSTGRES_PASSWORD='<ispravna-lozinka>'
kubectl -n ticketing rollout restart deployment/api
kubectl -n ticketing rollout status deployment/api
```

Sam restart je nužan: varijable okoline iz Secreta čitaju se pri pokretanju
kontejnera i ne osvježavaju se u živom podu.

**Validacija.**

```powershell
Invoke-RestMethod http://localhost:8080/api/readyz
# status
# ------
# ready
```

**Utjecaj na korisnike.** Nikakav. Mjerenje tijekom cijelog neuspjelog deploya:
**120 od 120 uspješnih zahtjeva.**

**Sigurnosna napomena.** Ni u jednom koraku dijagnostike lozinka se nije
pojavila u ispisu — ni u `get pods`, ni u `describe`, ni u logu. To je i svrha
Secreta. Vrijednost bi otkrio jedino `kubectl get secret -o yaml`, a upravo
zato operatorski račun `ticketing-operator` nema pravo čitanja Secreta.

---

## Scenarij D — gubitak zahtjeva tijekom zamjene verzije

**Simptom.** Tijekom `rollout` nekoliko zahtjeva ostane bez odgovora, iako su
replike stalno dostupne. Bez mjerenja se ne primijeti.

**Kako se otkriva.** Mjerač koji tijekom cijele zamjene poziva `/healthz`
svakih 500 ms i bilježi neuspjehe:

```powershell
1..80 | ForEach-Object {
  try { (Invoke-RestMethod http://localhost:8080/api/healthz -TimeoutSec 2).version }
  catch { "GRESKA" }
  Start-Sleep -Milliseconds 500
}
```

**Uzrok.** Pri gašenju poda `SIGTERM` i uklanjanje adrese iz odredišta Servicea
događaju se istodobno, a širenje promjene kroz klaster nije trenutno. U tom
kratkom prozoru promet još stiže podu koji već umire. Ako aplikacija na `SIGTERM`
odmah izađe, zahtjevi u tijeku ostaju bez odgovora.

**Korektivne mjere** (već ugrađene u manifeste i kod):

- `preStop` hook (`sleep 5`) — pod još posluživa dok se njegova adresa uklanja,
- `server.close()` prije zatvaranja baze i queuea u `api/src/server.js`,
- `terminationGracePeriodSeconds: 30`.

**Rezultat.**

| Mjerenje | Neuspjeli zahtjevi |
|---|---|
| Prije popravka (v1 → v2) | 2 |
| Nakon popravka (rollout restart) | 0 od 60 |

---

## Brza referenca

```powershell
# Stanje
kubectl -n ticketing get pods,svc,ingress,pvc
kubectl -n ticketing get events --sort-by=.lastTimestamp

# Zasto pod ne radi
kubectl -n ticketing describe pod <pod>
kubectl -n ticketing logs <pod> --previous     # log kontejnera prije restarta

# Provjera iznutra
kubectl -n ticketing exec <pod> -- wget -qO- http://localhost:8080/readyz
kubectl -n ticketing exec -it deploy/postgres -- psql -U ticketing_user -d ticketing -c "SELECT count(*) FROM ticket_orders;"

# Isporuka
kubectl -n ticketing rollout status deployment/<ime>
kubectl -n ticketing rollout history deployment/<ime>
kubectl -n ticketing rollout undo deployment/<ime>
kubectl -n ticketing rollout restart deployment/<ime>

# Mreza
kubectl -n ticketing get networkpolicy
kubectl -n ticketing get endpoints            # ima li Service uopce odrediste
```

## Kada eskalirati

- PVC ostaje u stanju `Pending` — problem sa storage klasom klastera, ne s aplikacijom.
- Podovi u stanju `Pending` uz poruku `Insufficient cpu/memory` — čvor nema resursa.
- `ImagePullBackOff` na slici koja postoji u registryju — vjerojatno istekao ili
  neispravan `imagePullSecret`.
