# Deployment u produkcijsko okruženje (Kubernetes)

Manifesti se nalaze u `k8s/` i imenovani su s brojčanim prefiksom jer ih
`kubectl apply -f k8s/` primjenjuje abecednim redom — tako namespace i
konfiguracija nastaju prije servisa koji o njima ovise.

| Datoteka | Sadržaj |
|---|---|
| `00-namespace.yaml` | Namespace `ticketing` |
| `01-configmap.yaml` | Ne-tajna konfiguracija aplikacije |
| `02-rbac.yaml` | ServiceAccount aplikacije, operatorski račun, Role i RoleBinding |
| `10-postgres.yaml` | ConfigMap s init skriptom, PVC, Deployment, Service |
| `11-redis.yaml` | Deployment i Service |
| `20-api.yaml` | Deployment (2 replike) i Service |
| `21-worker.yaml` | Deployment |
| `22-frontend.yaml` | Deployment (2 replike) i Service |
| `30-ingress.yaml` | Vanjski pristup: `/` → frontend, `/api` → api |
| `40-networkpolicy.yaml` | Default deny + eksplicitna dopuštenja |

## Preduvjeti

- Pokrenut Docker Desktop
- `kubectl` i `minikube` u PATH-u

## 1. Pokretanje klastera

```powershell
minikube start --cpus=2 --memory=4096
minikube addons enable ingress
kubectl get nodes
```

Čvor mora biti u stanju `Ready`. Addon `ingress` instalira nginx Ingress
kontroler u namespace `ingress-nginx`; bez njega Ingress objekt nema tko izvršiti.

## 2. Izgradnja i učitavanje slika

Slike se grade lokalno i učitavaju izravno u klaster. Registry se ovdje ne
koristi jer je repozitorij privatan, pa bi dohvat sa GHCR-a tražio i
`imagePullSecret`. U pravoj produkciji koristila bi se objavljena slika
označena commit SHA-om (vidi politiku objave u `security/image-scan-report.md`).

```powershell
docker build -t ticketing-api:v1 ./api
docker build -t ticketing-frontend:v1 ./frontend
docker build -t ticketing-worker:v1 ./worker

minikube image load ticketing-api:v1
minikube image load ticketing-frontend:v1
minikube image load ticketing-worker:v1
```

Manifesti koriste `imagePullPolicy: IfNotPresent` kako Kubernetes ne bi
pokušavao dohvatiti sliku izvana kad je već ima lokalno.

## 3. Kreiranje Secreta

Secret se **ne nalazi u repozitoriju** i kreira ga onaj tko izvodi deployment:

```powershell
kubectl apply -f k8s/00-namespace.yaml

kubectl create secret generic app-secret `
  --namespace ticketing `
  --from-literal=POSTGRES_PASSWORD='OdaberiJakuLozinku123!'
```

Provjera da je nastao (vrijednost se ne ispisuje):

```powershell
kubectl get secret app-secret -n ticketing
```

## 4. Primjena manifesta

```powershell
kubectl apply -f k8s/
kubectl get pods -n ticketing --watch
```

Očekivano konačno stanje: `postgres` i `redis` po jedan pod, `api` i `frontend`
po dva, `worker` jedan — svi `Running` i `READY 1/1`.

```powershell
kubectl get all -n ticketing
kubectl get pvc,ingress,networkpolicy,serviceaccount -n ticketing
```

## 5. Pristup aplikaciji

Na Windowsu s Docker driverom najpouzdaniji je prosljeđivanje porta na Ingress
kontroler. Ostavi ovaj prozor otvorenim:

```powershell
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80
```

U drugom prozoru:

```powershell
curl.exe http://localhost:8080/api/healthz
curl.exe http://localhost:8080/api/readyz

$body = '{"eventId":"evt-1001","customerEmail":"k8s@example.com","quantity":3}'
curl.exe -X POST http://localhost:8080/api/tickets/purchase -H "Content-Type: application/json" -d $body
curl.exe http://localhost:8080/api/tickets/orders
```

Web sučelje: <http://localhost:8080>.

Alternativa je `minikube tunnel` (traži administratorske ovlasti), nakon čega je
aplikacija dostupna na <http://localhost>.

## 6. Rolling update

Postupna zamjena verzije bez prekida rada. Prvo se izgradi i učita nova slika:

```powershell
docker build -t ticketing-api:v2 ./api
minikube image load ticketing-api:v2
```

Zatim se promijeni slika u Deploymentu i prati zamjena:

```powershell
kubectl -n ticketing set image deployment/api api=ticketing-api:v2
kubectl -n ticketing rollout status deployment/api
kubectl -n ticketing get pods -w
```

Zamjena je bezbolna zbog dvije postavke: `maxUnavailable: 0` znači da nijedna
stara replika ne smije nestati prije nego nova bude spremna, a readiness proba
na `/readyz` određuje kada je "spremna". Service u međuvremenu šalje promet
samo replikama koje su prošle provjeru.

Povijest zamjena:

```powershell
kubectl -n ticketing rollout history deployment/api
```

## 7. Rollback

Povratak na prethodnu verziju:

```powershell
kubectl -n ticketing rollout undo deployment/api
kubectl -n ticketing rollout status deployment/api
kubectl -n ticketing describe deployment api | Select-String "Image"
```

Na određenu reviziju:

```powershell
kubectl -n ticketing rollout undo deployment/api --to-revision=1
```

## 8. Brisanje okruženja

```powershell
kubectl delete namespace ticketing   # briše sve resurse projekta
minikube stop                         # zaustavlja klaster
minikube delete                       # potpuno uklanja klaster
```

## Sigurnosne postavke u manifestima

| Mjera | Gdje | Svrha |
|---|---|---|
| `runAsNonRoot`, `runAsUser: 10001` | api, worker, frontend | Proces ne vrti kao root |
| `allowPrivilegeEscalation: false` | isto | Proces ne može steći više ovlasti nego što ima |
| `readOnlyRootFilesystem: true` | isto | Napadač ne može pisati u sliku; zapisiv je samo `/tmp` u memoriji |
| `capabilities: drop ALL` | isto | Uklonjene sve Linux privilegije kernela |
| `seccompProfile: RuntimeDefault` | isto | Ograničen skup dopuštenih sistemskih poziva |
| `automountServiceAccountToken: false` | `ticketing-sa` | Aplikacija nema token za Kubernetes API — ne može biti ni ukraden |
| Role bez prava na `secrets` | `02-rbac.yaml` | Operatorski račun smije samo čitati stanje i logove |
| Default deny + explicit allow | `40-networkpolicy.yaml` | Baza i queue primaju promet samo od api i workera |
| Secret izvan repozitorija | korak 3 | Lozinka nikad ne ulazi u git |
