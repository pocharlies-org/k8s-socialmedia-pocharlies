# SKIRM-107 · guard Cross-account identifier en accountKey
- Antes: `accountKey(account, id)` prefijaba sin queja un id ya namespaced a otra cuenta (`accountKey('professional','leila:123')` → `professional:leila:123`) y lo escribía/leía bajo la cuenta equivocada.
- Ahora: lanza `AccountRegistryError('Cross-account identifier')`; el id propio sigue idempotente y el desnudo se prefija igual. `inEveryNamespace` y `brainScopes` (`search.service.ts`) devuelven/preguntan solo la cuenta del id si ya la lleva.
- Quién se mueve: quien llame a una tool con un id de otra cuenta recibe error (antes, resultado vacío o fila mal asignada); un conector que envíe un id de otra cuenta pierde esa fila (queda en el log de ingestión). Nadie más.
- Decisión: `nota-architect-plan.md` de SKIRM-99, sección SKIRM-107 (architect, forma exacta del guard); `brainScopes` es el mismo ajuste que `inEveryNamespace`, tomado aquí.
