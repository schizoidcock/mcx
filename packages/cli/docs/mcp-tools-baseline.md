# MCX MCP Tools - Baseline Documentation

Documentación de las tools MCP actuales para comparación con el nuevo código.

## Tools Disponibles (Versión Actual)

### 1. mcx_list

Lista todos los adapters y skills disponibles.

**Parámetros:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| truncate | boolean | true | Truncar resultados grandes |
| maxItems | integer | 20 | Max adapters/skills (1-500) |

**Ejemplo de respuesta:**
```json
{
  "adapters": [
    {"name": "alegra", "description": "Alegra API - 233 endpoints", "methodCount": 233},
    {"name": "chrome-devtools", "description": "Chrome DevTools Protocol...", "methodCount": 25},
    {"name": "supabase", "description": "Supabase Management API", "methodCount": 24}
  ],
  "skills": [
    {"name": "hello", "description": "A simple hello world skill"}
  ],
  "truncated": false,
  "total": {"adapters": 5, "skills": 1},
  "hint": "Use mcx_search(query) to see method details and TypeScript signatures"
}
```

---

### 2. mcx_search

Busca adapters, métodos o skills por nombre o descripción.

**Parámetros:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| query | string | - | Término de búsqueda |
| adapter | string | - | Filtrar por adapter específico |
| method | string | - | Filtrar por método (exact match → params detallados) |
| type | enum | "all" | Filtrar por tipo: all, adapters, methods, skills |
| limit | integer | 20 | Max resultados por categoría (1-100) |

**Comportamiento especial:**
- Match exacto de método → muestra parámetros detallados con tipos, required, defaults
- Match parcial → muestra lista compacta con TypeScript signature

**Ejemplo - Búsqueda por adapter:**
```json
{
  "adapters": [{"name": "supabase", "matchedMethods": ["list_organizations", ...]}],
  "methods": [
    {
      "adapter": "supabase",
      "method": "execute_sql",
      "description": "Execute SQL query",
      "typescript": "supabase.execute_sql({ project_id?: string, query?: string, read_only?: boolean }): Promise<unknown>"
    }
  ],
  "pagination": {"methods_truncated": 4}
}
```

**Ejemplo - Match exacto (parámetros detallados):**
```json
{
  "methods": [{
    "adapter": "supabase",
    "method": "execute_sql",
    "description": "Execute SQL query",
    "typescript": "supabase.execute_sql(...): Promise<unknown>",
    "parameters": {
      "project_id": {"type": "string", "description": "Project ID", "required": false},
      "query": {"type": "string", "description": "SQL query", "required": false},
      "read_only": {"type": "boolean", "description": "Read-only mode", "required": false, "default": true}
    },
    "example": "await supabase.execute_sql()"
  }]
}
```

---

### 3. mcx_execute

Ejecuta código JavaScript/TypeScript en sandbox aislado.

**Parámetros:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| code | string | required | Código JS/TS a ejecutar |
| truncate | boolean | true | Truncar resultados grandes |
| maxItems | integer | 10 | Max items en arrays (1-1000) |
| maxStringLength | integer | 500 | Max longitud strings (10-10000) |

**Helpers disponibles:**
- `pick(arr, ['id', 'name'])` - Extraer campos específicos
- `first(arr, 5)` - Primeros N items
- `count(arr, 'field')` - Contar por valor de campo
- `sum(arr, 'field')` - Sumar campo numérico
- `table(arr)` - Formatear como tabla markdown

**Ejemplo de respuesta exitosa:**
```json
{
  "result": {
    "organizations": [{"id": "xyz", "name": "papicandela"}],
    "projectCount": 3,
    "projects": [{"id": "abc", "name": "PlatanoIA", "status": "INACTIVE"}]
  },
  "logs": [],
  "executionTime": 205.92,
  "truncated": false,
  "imagesAttached": 0
}
```

**Ejemplo de error:**
```json
{
  "error": "Execution error: Error: Alegra_official_endpoints API error (400): {\"code\":903,\"message\":\"El límite de facturas...\"}"
}
```

**Truncación activa:**
```json
{
  "result": [...], // Solo maxItems elementos
  "truncated": true
}
```

---

### 4. mcx_run_skill

Ejecuta un skill registrado por nombre.

**Parámetros:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| skill | string | required | Nombre del skill |
| inputs | object | {} | Parámetros de entrada |
| truncate | boolean | true | Truncar resultados |
| maxItems | integer | 10 | Max items en arrays |
| maxStringLength | integer | 500 | Max longitud strings |

**Ejemplo:**
```json
// Input
{"skill": "hello", "inputs": {"name": "Claude"}}

// Output
{"result": "Hello, Claude!", "truncated": false}
```

---

## Características Observadas

### Truncación
- Respeta `maxItems` para arrays
- Indica `truncated: true` cuando se trunca
- No hay truncación smart 60/40 (head/tail) visible

### Manejo de Errores
- Errores de API se propagan con mensaje descriptivo
- Formato: `"Execution error: Error: <adapter> API error (<status>): <message>"`

### Performance
- `executionTime` en ms incluido en respuesta
- Queries típicas: 200-300ms
- Queries con múltiples llamadas API: 3000ms+

### Adapters Disponibles (Test Environment)
| Adapter | Methods | Description |
|---------|---------|-------------|
| alegra | 233 | Alegra API (facturación) |
| chrome-devtools | 25 | Browser automation |
| dotcms_api_md | 671 | DotCMS API |
| example | 1 | Adapter de ejemplo |
| supabase | 24 | Supabase Management API |

---

## Tools Nuevas (No disponibles aún en baseline)

Las siguientes tools están implementadas pero no expuestas en el MCP actual:

- **mcx_batch** - Ejecutar múltiples operaciones sin throttling
- **mcx_file** - Procesar archivos locales con $file
- **mcx_fetch** - Fetch URL e indexar contenido
- **mcx_stats** - Estadísticas de sesión

---

## Catálogo de Errores

### mcx_execute

| Tipo de Error | Mensaje | Causa |
|---------------|---------|-------|
| ReferenceError | `nonexistent is not defined` | Variable/adapter no existe |
| TypeError | `supabase.nonexistent_method is not a function` | Método no existe en adapter |
| SyntaxError | `Unexpected token (1:11)` | Código JS inválido |
| Error | `Custom error message` | throw explícito en código |
| API Error | `Alegra_official_endpoints API error (400): {...}` | Error de API externa |

**Formato de error:**
```
Execution error: <ErrorType>: <message>

Logs:
```

### mcx_search

| Escenario | Respuesta |
|-----------|-----------|
| Adapter no existe | `{"adapters": [], "methods": [], "skills": []}` (vacío, no error) |
| Query sin resultados | Arrays vacíos, no error |

### mcx_run_skill

| Tipo de Error | Mensaje |
|---------------|---------|
| Skill no existe | `Error: Skill 'nonexistent_skill' not found.\n\nAvailable: hello` |

---

## Consumo de Tokens (Estimación)

### Tamaño de Respuestas por Tipo

| Tipo | Ejemplo | Chars | Tokens (~) |
|------|---------|-------|------------|
| **Small** | `{count: 5, items: ["a","b","c"]}` | ~100 | ~25 |
| **Medium** | 3 projects con campos básicos | ~500 | ~125 |
| **Large** | 5 invoices completas (sin truncar) | ~25,000 | ~6,250 |
| **Truncated** | 3 invoices (maxItems: 3) | ~15,000 | ~3,750 |

### Impacto de Truncación

| Parámetro | Sin truncar | Con truncar | Ahorro |
|-----------|-------------|-------------|--------|
| 5 invoices Alegra | ~25K chars | ~15K chars (maxItems:3) | ~40% |
| 10 invoices Alegra | ~50K chars | ~15K chars (maxItems:3) | ~70% |

### Estructura de Respuesta (Overhead)

```json
{
  "result": <data>,           // Variable
  "logs": [],                 // ~10 chars
  "executionTime": 205.92,    // ~25 chars
  "truncated": false,         // ~20 chars
  "imagesAttached": 0         // ~20 chars
}
// Overhead total: ~75-100 chars (~25 tokens)
```

### mcx_search Token Usage

| Query Type | Chars | Tokens (~) |
|------------|-------|------------|
| Adapter list (supabase) | ~3,000 | ~750 |
| Method exact match | ~800 | ~200 |
| Query "invoice" (20 methods) | ~5,000 | ~1,250 |

### mcx_list Token Usage

| Escenario | Chars | Tokens (~) |
|-----------|-------|------------|
| 5 adapters, 1 skill | ~600 | ~150 |

---

## Problemas de Token Efficiency Identificados

### 1. Sin Smart Truncation
- Truncación actual: corta al final del array
- No preserva head + tail (60/40)
- Información final (errores, totales) se pierde

### 2. Sin Intent/Auto-Index
- Resultados grandes siempre van al contexto
- No hay opción de indexar y buscar después
- Cada query repite data completa

### 3. Sin Variables Persistentes
- No hay `storeAs` para reusar resultados
- Cada operación requiere re-fetch de data

### 4. Sin Throttling
- Múltiples llamadas grandes pueden saturar contexto
- No hay límites progresivos

### 5. Nested Objects Redundantes
- Invoices incluyen tax categories completas (~500 chars cada una)
- Información repetida en cada item
- Sin deduplicación automática

---

## Comparación: Baseline vs Nuevo Código

| Feature | Baseline | Nuevo |
|---------|----------|-------|
| Truncación | Simple (cortar final) | Smart 60/40 head/tail |
| Auto-index | No | Sí (intent > 5KB) |
| Variables | No | `storeAs` persistente |
| FTS Search | No | 3-layer (Porter/Trigram/Fuzzy) |
| Throttling | No | Progresivo (3/8 calls) |
| Batch ops | No | `mcx_batch` |
| File processing | No | `mcx_file` |
| URL fetch | No | `mcx_fetch` |
| Stats | No | `mcx_stats` |

---

## Fecha de Documentación
2026-03-06
