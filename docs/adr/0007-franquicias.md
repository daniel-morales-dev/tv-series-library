# 0007 — Franquicias: títulos independientes agrupados en la UI

**Estado:** aceptado · 2026-10-10

## Contexto
Hay continuaciones que TMDB modela como series distintas (Monogatari → Nisemonogatari). `Saga` (`Collection`) solo agrupa películas y no existe relación entre títulos. El dueño quiere verlas juntas, ordenadas, indicando si cada entrega es serie o película.

## Decisión
1. **Cada entrega sigue siendo un título propio** con su `tmdb_id`, temporadas, pósters y metadata de TMDB. No se fusiona nada bajo un título único: obligaría a inventar temporadas y a que los datos dejen de coincidir con TMDB.
2. **Franquicia** (`franchises` + `titles.franchise_id` / `franchise_order`) agrupa títulos en orden. Se guarda en SQLite y nunca se vuelve a consultar TMDB.
3. **Cómo se crea:** manual, una vez. Al confirmar un archivo en Pending (`franchiseOfTitleId`, `franchiseRelation`) o con `POST /api/titles/:id/franchise` para títulos ya importados; `DELETE` la deshace. TMDB no expone una relación precuela/secuela para series que verifiquemos, así que no se infiere.
4. **UI:** la ficha del título muestra "Relacionados": tira ordenada Precuela / Actual / Secuela con etiqueta Serie o Película. Una franquicia con menos de dos títulos no existe.

## Consecuencias
- No hay etiqueta OVA: el esquema no la guarda; se muestra Serie.
- El enlace es manual hasta que exista una pantalla web de Pending.
- Fase 2 posible: una tarjeta por franquicia en Home/Browse.
