"""Goal checks on the robot's own map (node dump format). Pure numpy: no robot, DDS, network or GPU.

Map format (``node.py --dump-memory``, docs/NAVIGATE.md §5): ``support`` and ``ceiling`` (n x n float64;
NaN = never observed; ``ceiling`` +inf = observed clear), ``lo`` (2,), ``res`` (scalar), ``boxes`` (JSON
string, Flow ``memory_boxes``) and ``stats`` (JSON string).

Index convention, verified against the sources: cell ``[i, j]`` has its centre at ``lo + (i, j) * res``, i
along x. Flow ``sensor_map.SensorMapMemory`` builds its cell centres with ``meshgrid(..., indexing="ij")``
and ``memory_boxes`` maps cell ``(i, j)`` to ``(i, j) * res + lo``; g1-student-deploy
``CloudMemory._cells`` writes a point at ``ij = round((xy - lo) / res)`` into flat cell ``i * n + j``.

Checks (always all six, in this order): inside, seen, free, overhead, reachable, distance.

- ``overhead`` mirrors g1-student-deploy ``node.py`` ``Node.ceiling_near``: any finite ceiling lower than
  ``head_height_m`` in the square window of ``ceil(overhead_radius_m / res)`` cells around the goal cell.
  The node defers its stand there because standing up drives the head into the obstacle.
- ``reachable`` mirrors Flow ``route.SensorRoute.refresh`` and ``Route._plan``: occupied = observed support
  (NaN -> 0) above ``step_over_m``, grown ``grow_unknown_m`` into never-observed cells (4-connected, as
  ``binary_dilation(mask=occ | isnan(support))``), dilated with a disc of ``ceil(inflate_m / res)`` cells;
  unseen cells are otherwise free. Start and goal cells inside that occupancy move to the nearest free
  cell (``Route._nearest_free``), A* (8-connected, Euclidean heuristic) searches the grid and the path is
  shortened by line-of-sight pruning; the first and last points stay the true start and goal.
  ``grow_unknown_m`` defaults to 0.1 m, the value g1-student-deploy ``bundle.student_config`` gives the
  node's sensor route. Pass 0 for the plain SensorRoute default.

Every status is ``pass``, ``warn`` or ``block``; a check that cannot be evaluated says so and never passes
silently. ``ok`` is true when no check blocks.
"""
from __future__ import annotations

import hashlib
import heapq
import io
import json
import math
from pathlib import Path
import zipfile

import numpy as np

MAX_SIDE = 1201
MIN_SIDE = 3
MIN_RES_M, MAX_RES_M = 0.01, 0.5
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ARRAY_BYTES = MAX_SIDE * MAX_SIDE * 8 + 4096
MAX_MEMBER_BYTES = {'support': MAX_ARRAY_BYTES, 'ceiling': MAX_ARRAY_BYTES, 'lo': 4096, 'res': 4096,
                    'boxes': 8 * 1024 * 1024, 'stats': 1024 * 1024}
MAX_MEMBERS = 16
MAX_TOTAL_BYTES = 2 * MAX_ARRAY_BYTES + 10 * 1024 * 1024
MAX_SOURCE_BOXES = 4096
MAX_HEIGHT_M = 100.0
MAX_PATH_POINTS = 200
MAX_SEARCH_SIDE = 401          # larger grids are searched on conservatively max-pooled blocks
MAX_PRUNE_SAMPLES = 4_000_000  # bound on line-of-sight samples; beyond it the raw path is kept
UNKNOWN_WARN_FRACTION = 0.3
SEEN_WARN_FRACTION = 0.5
CHECK_IDS = ('inside', 'seen', 'free', 'overhead', 'reachable', 'distance')
DEFAULT_BASIS = 'planner memory'


# ----- loading and validation ---------------------------------------------------------------------------

def _strict_json(text, name):
    def reject(constant):
        raise ValueError(f'{name} contains the non-JSON number {constant}')
    try:
        return json.loads(text, parse_constant=reject)
    except json.JSONDecodeError as error:
        raise ValueError(f'{name} is not valid JSON') from error


def _finite_float(value, name, low=-math.inf, high=math.inf):
    if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise ValueError(f'{name} must be a number')
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name} must be finite in [{low}, {high}]')
    return value


def _xy(value, name):
    if value is None:
        raise ValueError(f'{name} is required')
    array = np.asarray(value, dtype=object) if not isinstance(value, np.ndarray) else value
    if array.shape != (2,):
        raise ValueError(f'{name} needs two coordinates')
    return np.array([_finite_float(v, name, -1e4, 1e4) for v in array.tolist()], dtype=np.float64)


def _clean_box(box, index):
    if not isinstance(box, dict):
        raise ValueError(f'Source box {index} must be an object')
    try:
        clean = {'center_xy': [_finite_float(v, 'box center') for v in box['center_xy']],
                 'half_xy': [_finite_float(v, 'box half extent', 0.0) for v in box['half_xy']],
                 'yaw': _finite_float(box.get('yaw', 0.0), 'box yaw'),
                 'z_bottom': _finite_float(box['z_bottom'], 'box bottom'),
                 'z_top': _finite_float(box['z_top'], 'box top')}
    except (KeyError, TypeError) as error:
        raise ValueError(f'Source box {index} lacks center_xy, half_xy, z_bottom or z_top') from error
    if len(clean['center_xy']) != 2 or len(clean['half_xy']) != 2:
        raise ValueError(f'Source box {index} needs 2-D center and half extents')
    return clean


def grid_from_arrays(support, ceiling, lo, res, *, boxes=None, stats=None, basis=DEFAULT_BASIS, source=None,
                     sha256=None):
    """Validate map layers already in memory (a live CloudMemory, a test grid) into the grid dict.

    Returns {support, ceiling, lo, res, n, boxes, stats, basis, source, sha256}; arrays are read-only copies.
    ``boxes`` is None when the source had no boxes field, a (possibly empty) list otherwise.
    """
    layers = {}
    for name, raw in (('support', support), ('ceiling', ceiling)):
        array = np.asarray(raw)
        if array.dtype.kind != 'f':
            raise ValueError(f'{name} must be a floating-point array')
        if array.ndim != 2 or array.shape[0] != array.shape[1]:
            raise ValueError(f'{name} must be a square 2-D array')
        layers[name] = np.array(array, dtype=np.float64)
    support, ceiling = layers['support'], layers['ceiling']
    if support.shape != ceiling.shape:
        raise ValueError('support and ceiling must have the same shape')
    n = int(support.shape[0])
    if not MIN_SIDE <= n <= MAX_SIDE:
        raise ValueError(f'Map side must be {MIN_SIDE}–{MAX_SIDE} cells')
    if np.isinf(support).any():
        raise ValueError('support must be finite or NaN (never observed)')
    if np.isneginf(ceiling).any():
        raise ValueError('ceiling must be finite, NaN (never observed) or +inf (observed clear)')
    for name, array in (('support', support), ('ceiling', ceiling)):
        finite = array[np.isfinite(array)]
        if finite.size and np.abs(finite).max() > MAX_HEIGHT_M:
            raise ValueError(f'{name} heights exceed ±{MAX_HEIGHT_M:g} m')
    lo_array = np.asarray(lo)
    if lo_array.shape != (2,) or lo_array.dtype.kind not in 'fiu':
        raise ValueError('lo must be two numbers')
    lo_array = lo_array.astype(np.float64)
    if not np.isfinite(lo_array).all() or np.abs(lo_array).max() > 1e4:
        raise ValueError('lo must be finite within ±10 km')
    res_array = np.asarray(res)
    if res_array.shape not in ((), (1,)) or res_array.dtype.kind not in 'fiu':
        raise ValueError('res must be a scalar')
    res_value = float(res_array.reshape(()))
    if not math.isfinite(res_value) or not MIN_RES_M <= res_value <= MAX_RES_M:
        raise ValueError(f'res must be within [{MIN_RES_M}, {MAX_RES_M}] m')
    if boxes is not None:
        if not isinstance(boxes, list) or len(boxes) > MAX_SOURCE_BOXES:
            raise ValueError(f'boxes must be a list of at most {MAX_SOURCE_BOXES}')
        boxes = [_clean_box(box, index) for index, box in enumerate(boxes)]
    if stats is None:
        stats = {}
    if not isinstance(stats, dict):
        raise ValueError('stats must be a JSON object')
    if not isinstance(basis, str) or not basis.strip() or len(basis) > 100:
        raise ValueError('basis must be 1–100 characters')
    for array in (support, ceiling, lo_array):
        array.setflags(write=False)
    return {'support': support, 'ceiling': ceiling, 'lo': lo_array, 'res': res_value, 'n': n,
            'boxes': boxes, 'stats': stats, 'basis': basis.strip(), 'source': source, 'sha256': sha256}


def _string_member(z, name):
    array = z[name]
    if array.dtype.kind not in 'US' or array.size != 1:
        raise ValueError(f'{name} must be a JSON string')
    value = array.reshape(()).item()
    return value.decode('utf-8') if isinstance(value, bytes) else value


def load_grid(path, *, basis=DEFAULT_BASIS):
    """Read a map in node dump format with bounded, pickle-free parsing. Raises ValueError when malformed."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f'Map file not found: {path}')
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('Map file exceeds the bounded read limit')
    data = path.read_bytes()  # one read: the hash and the parse see the same bytes
    if len(data) > MAX_FILE_BYTES:
        raise ValueError('Map file exceeds the bounded read limit')
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise ValueError('Map file is not an npz archive')
    try:
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            if not hasattr(z, 'zip'):
                raise ValueError('Map file is not an npz archive')
            infos = z.zip.infolist()
            if len(infos) > MAX_MEMBERS:
                raise ValueError('Map archive has too many members')
            if sum(info.file_size for info in infos) > MAX_TOTAL_BYTES:
                raise ValueError('Map archive expands beyond the bounded size')
            sizes = {info.filename[:-4] if info.filename.endswith('.npy') else info.filename: info.file_size
                     for info in infos}
            for name in ('support', 'ceiling', 'lo', 'res'):
                if name not in sizes:
                    raise ValueError(f'Map file lacks {name}')
            for name, limit in MAX_MEMBER_BYTES.items():
                if sizes.get(name, 0) > limit:
                    raise ValueError(f'Map member {name} exceeds its bounded size')
            support, ceiling, lo, res = (z[name] for name in ('support', 'ceiling', 'lo', 'res'))
            boxes = _strict_json(_string_member(z, 'boxes'), 'boxes') if 'boxes' in sizes else None
            stats = _strict_json(_string_member(z, 'stats'), 'stats') if 'stats' in sizes else None
    except (zipfile.BadZipFile, EOFError, OSError, KeyError) as error:
        raise ValueError(f'Malformed map file: {type(error).__name__}') from error
    return grid_from_arrays(support, ceiling, lo, res, boxes=boxes, stats=stats, basis=basis,
                            source=str(path), sha256=hashlib.sha256(data).hexdigest())


# ----- grid helpers ---------------------------------------------------------------------------------------

def _require_grid(grid):
    if not isinstance(grid, dict):
        raise ValueError('grid must come from load_grid or grid_from_arrays')
    try:
        support, ceiling, lo, res, n = grid['support'], grid['ceiling'], grid['lo'], grid['res'], grid['n']
    except KeyError as error:
        raise ValueError('grid must come from load_grid or grid_from_arrays') from error
    if support.shape != (n, n) or ceiling.shape != (n, n):
        raise ValueError('grid layers do not match n')
    return support, ceiling, np.asarray(lo, dtype=np.float64), float(res), int(n)


def observed_mask(grid):
    """Cells with a recorded support height (floor or obstacle top), as Flow ``ego_map`` counts them."""
    return np.isfinite(grid['support'])


MAP_CODES = {0: 'never observed', 1: 'floor', 2: 'low obstacle (steps over)', 3: 'obstacle', 4: 'overhead'}


def map_codes(support, ceiling):
    """Per-cell display codes (MAP_CODES) and heights in cm (support, or the ceiling underside for code 4).

    0 never observed, 1 floor, 2 low obstacle (0.05-0.25 m: the route steps over it), 3 obstacle (above 0.25 m:
    the route avoids it), 4 overhead (a ceiling seen below 2 m over floor). Both uint8 arrays, shaped as the input.
    """
    support, ceiling = np.asarray(support, dtype=float), np.asarray(ceiling, dtype=float)
    codes = np.zeros(support.shape, dtype=np.uint8)
    seen = np.isfinite(support)
    codes[seen] = 1
    codes[seen & (support > 0.05)] = 2
    codes[seen & (support > 0.25)] = 3
    overhead = np.isfinite(ceiling) & (ceiling < 2.0)
    codes[overhead & (codes < 2)] = 4
    height = np.where(codes == 4, np.nan_to_num(ceiling, nan=0, posinf=0), np.nan_to_num(support, nan=0))
    return codes, np.clip(np.round(height * 100), 0, 255).astype(np.uint8)


def cell_of(lo, res, xy):
    """Nearest cell index (may lie outside the grid), as ``CloudMemory._cells`` and ``Route.cell`` round."""
    return np.round((np.asarray(xy, dtype=np.float64) - lo) / res).astype(int)


def _in_grid(ij, n):
    return bool(0 <= ij[0] < n and 0 <= ij[1] < n)


def _dilate_disc(mask, k):
    """``binary_dilation(mask, structure=x*x + y*y <= k*k)`` with zero border, as SensorRoute inflates."""
    if k <= 0 or not mask.any():
        return mask.copy()
    n0, n1 = mask.shape
    csum = np.zeros((n0, n1 + 1), dtype=np.int32)
    np.cumsum(mask, axis=1, out=csum[:, 1:])
    columns = np.arange(n1)
    rows_by_width = {}
    out = np.zeros_like(mask)
    for dy in range(-k, k + 1):
        w = math.isqrt(k * k - dy * dy)
        if w not in rows_by_width:
            right = np.minimum(columns + w + 1, n1)
            left = np.maximum(columns - w, 0)
            rows_by_width[w] = (csum[:, right] - csum[:, left]) > 0
        wide = rows_by_width[w]
        if dy >= 0:
            out[:n0 - dy] |= wide[dy:]
        else:
            out[-dy:] |= wide[:n0 + dy]
    return out


def _grow_into_unknown(occ, unknown, iterations):
    """``binary_dilation(occ, iterations, mask=occ | unknown)`` with the default 4-connected structure."""
    allowed = occ | unknown
    for _ in range(iterations):
        grown = occ.copy()
        grown[1:] |= occ[:-1]
        grown[:-1] |= occ[1:]
        grown[:, 1:] |= occ[:, :-1]
        grown[:, :-1] |= occ[:, 1:]
        grown &= allowed
        if np.array_equal(grown, occ):
            break
        occ = grown
    return occ


def route_occupancy(grid, *, step_over_m=0.25, inflate_m=0.35, grow_unknown_m=0.1):
    """The SensorRoute routing grid: True where the route may not pass."""
    support, _, _, res, _ = _require_grid(grid)
    occ = np.nan_to_num(support, nan=0.0) > step_over_m
    if grow_unknown_m > 0 and occ.any():
        occ = _grow_into_unknown(occ, np.isnan(support), int(round(grow_unknown_m / res)))
    return _dilate_disc(occ, int(np.ceil(inflate_m / res)))


def _nearest_free(occupied, ij):
    """``Route._nearest_free``: the cell itself when free, else the nearest free cell (None when none)."""
    ij = (int(ij[0]), int(ij[1]))
    if not occupied[ij]:
        return ij
    free = np.argwhere(~occupied)
    if not len(free):
        return None
    d = np.linalg.norm(free - np.asarray(ij), axis=1)
    return tuple(int(v) for v in free[np.argmin(d)])


def _astar(occupied, start, goal):
    """``Route._plan``'s A*: 8-connected, Euclidean heuristic, (f, cost, cell) heap order, lazy deletion."""
    n0, n1 = occupied.shape
    width = n1 + 2
    padded = np.ones((n0 + 2, width), dtype=bool)
    padded[1:-1, 1:-1] = occupied
    blocked = padded.ravel().tolist()
    s = (start[0] + 1) * width + start[1] + 1
    g = (goal[0] + 1) * width + goal[1] + 1
    gi, gj = goal[0] + 1, goal[1] + 1
    moves = [(dx * width + dy, math.hypot(dx, dy)) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
    best = [math.inf] * len(blocked)
    parent = [-1] * len(blocked)
    best[s] = 0.0
    parent[s] = s
    hypot, push, pop = math.hypot, heapq.heappush, heapq.heappop
    heap = [(hypot(start[0] - goal[0], start[1] - goal[1]), 0.0, s)]
    while heap:
        _, cost, cur = pop(heap)
        if cur == g:
            break
        if cost > best[cur]:
            continue
        for offset, weight in moves:
            nxt = cur + offset
            if blocked[nxt]:
                continue
            nc = cost + weight
            if nc < best[nxt]:
                best[nxt] = nc
                parent[nxt] = cur
                i, j = divmod(nxt, width)
                push(heap, (nc + hypot(i - gi, j - gj), nc, nxt))
    if parent[g] < 0:
        return None
    cells = [g]
    while cells[-1] != s:
        cells.append(parent[cells[-1]])
    cells.reverse()
    return [(c // width - 1, c % width - 1) for c in cells]


def _visible(occupied, lo, res, a, ends):
    """``Route.free_line(a, b)`` for every row b of ``ends``: samples every half cell, nearest cell, clipped."""
    n0, n1 = occupied.shape
    span = ends - a
    counts = np.ceil(np.linalg.norm(span, axis=1) / (0.5 * res)).astype(int) + 1
    total = int(counts.sum())
    first = np.repeat(np.cumsum(counts) - counts, counts)
    step = np.arange(total) - first
    t = step / np.repeat(np.maximum(counts - 1, 1), counts)
    points = a + t[:, None] * np.repeat(span, counts, axis=0)
    ij = np.round((points - lo) / res).astype(int)
    ij[:, 0] = np.clip(ij[:, 0], 0, n0 - 1)
    ij[:, 1] = np.clip(ij[:, 1], 0, n1 - 1)
    hits = occupied[ij[:, 0], ij[:, 1]].astype(np.int32)
    return np.add.reduceat(hits, np.cumsum(counts) - counts) == 0, total


def _prune(raw, occupied, lo, res, chunk=64):
    """``Route._plan``'s line-of-sight pruning (farthest visible point first), vectorized and bounded."""
    out, i, budget = [raw[0]], 0, MAX_PRUNE_SAMPLES
    last = len(raw) - 1
    while i < last:
        j = i + 1
        top = last
        while top > i + 1:
            low = max(i + 2, top - chunk + 1)
            candidates = np.arange(top, low - 1, -1)
            visible, used = _visible(occupied, lo, res, raw[i], raw[candidates])
            budget -= used
            if visible.any():
                j = int(candidates[int(np.argmax(visible))])
                break
            if budget <= 0:
                return np.vstack([np.array(out), raw[i + 1:]]), False
            top = low - 1
        out.append(raw[j])
        i = j
    return np.array(out), True


def plan_route(grid, start_xy, goal_xy, *, step_over_m=0.25, inflate_m=0.35, grow_unknown_m=0.1, _occupancy=None):
    """Flow SensorRoute's path on this grid.

    Returns {found, reason, path_xy ((m, 2) array, first/last = the true start/goal), pruned, search_res_m,
    start_shift_m, goal_shift_m (how far _nearest_free moved each end; 0 when it was free)}.
    """
    _, _, lo, res, n = _require_grid(grid)
    start, goal = _xy(start_xy, 'start'), _xy(goal_xy, 'goal')
    occ = _occupancy if _occupancy is not None else route_occupancy(
        grid, step_over_m=step_over_m, inflate_m=inflate_m, grow_unknown_m=grow_unknown_m)
    factor = 1 if n <= MAX_SEARCH_SIDE else math.ceil(n / MAX_SEARCH_SIDE)
    if factor > 1:
        side = math.ceil(n / factor) * factor
        padded = np.ones((side, side), dtype=bool)
        padded[:n, :n] = occ
        search = padded.reshape(side // factor, factor, side // factor, factor).any(axis=(1, 3))
    else:
        search = occ
    result = {'found': False, 'reason': None, 'path_xy': None, 'pruned': None, 'search_res_m': res * factor,
              'start_shift_m': None, 'goal_shift_m': None}
    ends = []
    for xy in (start, goal):
        fine = np.clip(cell_of(lo, res, xy), 0, n - 1)
        coarse = tuple(int(v) for v in fine // factor)
        free = _nearest_free(search, coarse)
        if free is None:
            result['reason'] = 'Every cell of the map is inside the route margin of an obstacle'
            return result
        ends.append((coarse, free))
    centre = lambda ij: lo + (np.asarray(ij, dtype=np.float64) * factor + (factor - 1) / 2.0) * res
    result['start_shift_m'] = 0.0 if ends[0][0] == ends[0][1] else float(np.linalg.norm(centre(ends[0][1]) - start))
    result['goal_shift_m'] = 0.0 if ends[1][0] == ends[1][1] else float(np.linalg.norm(centre(ends[1][1]) - goal))
    cells = _astar(search, ends[0][1], ends[1][1])
    if cells is None:
        result['reason'] = 'No route around the seen obstacles'
        return result
    raw = np.array([centre(c) for c in cells]) if len(cells) > 1 else np.empty((0, 2))
    raw = np.vstack([start, raw[1:-1], goal]) if len(cells) > 1 else np.vstack([start, goal])
    path, pruned = _prune(raw, occ, lo, res)
    result.update(found=True, path_xy=path, pruned=pruned)
    return result


def _sample_path(path, res):
    pieces = []
    for a, b in zip(path[:-1], path[1:]):
        steps = max(1, int(math.ceil(np.linalg.norm(b - a) / (0.5 * res))))
        t = (np.arange(steps) + 0.5) / steps
        pieces.append(a + t[:, None] * (b - a))
    return np.vstack(pieces) if pieces else np.empty((0, 2))


def _decimate(path, limit=MAX_PATH_POINTS):
    if len(path) <= limit:
        return path
    return path[np.unique(np.linspace(0, len(path) - 1, limit).round().astype(int))]


def _metres(value):
    return f'{value:.2f} m'


def _check(check_id, status, label, detail):
    return {'id': check_id, 'status': status, 'label': label, 'detail': detail}


# ----- the goal check ---------------------------------------------------------------------------------------

def check_goal(grid, robot_xy, goal_xy, *, robot_radius_m=0.30, arrival_radius_m=0.4, step_over_m=0.25,
               inflate_m=0.35, low_obstacle_m=0.05, overhead_radius_m=0.8, head_height_m=1.35,
               edge_margin_m=0.5, max_distance_m=None, grow_unknown_m=0.1, basis=None):
    """Check a goal on the robot's own map. See docs/NAVIGATE.md §5 and the module docstring.

    ``robot_xy`` None means the robot's position is unknown: reachability then blocks. ``basis`` None uses the
    grid's own basis label. Raises ValueError for malformed input; never returns NaN or infinity.
    """
    support, ceiling, lo, res, n = _require_grid(grid)
    goal = _xy(goal_xy, 'goal_xy')
    robot = None if robot_xy is None else _xy(robot_xy, 'robot_xy')
    options = {'robot_radius_m': robot_radius_m, 'arrival_radius_m': arrival_radius_m, 'step_over_m': step_over_m,
               'inflate_m': inflate_m, 'low_obstacle_m': low_obstacle_m, 'overhead_radius_m': overhead_radius_m,
               'head_height_m': head_height_m}
    for name, value in options.items():
        _finite_float(value, name, 0.0, 100.0)
    _finite_float(edge_margin_m, 'edge_margin_m', 0.0, 100.0)
    _finite_float(grow_unknown_m, 'grow_unknown_m', 0.0, 10.0)
    if max_distance_m is not None:
        _finite_float(max_distance_m, 'max_distance_m', 0.0, 1e4)
    if low_obstacle_m > step_over_m:
        raise ValueError('low_obstacle_m must not exceed step_over_m')
    basis = basis if basis is not None else grid.get('basis') or DEFAULT_BASIS
    observed = np.isfinite(support)
    hi = lo + (n - 1) * res
    goal_cell = cell_of(lo, res, goal)
    goal_in_grid = _in_grid(goal_cell, n)
    checks = []

    # inside: the planner memory is a fixed n x n grid; near its edge the arrival area and route fall off it.
    edge = float(min(goal[0] - lo[0], hi[0] - goal[0], goal[1] - lo[1], hi[1] - goal[1]))
    size = f'{(n - 1) * res:.1f} × {(n - 1) * res:.1f} m'
    if edge < 0:
        checks.append(_check('inside', 'block', 'Outside the map',
                             f"The goal is {_metres(-edge)} outside the {basis}'s {size} grid; the planner's memory "
                             'cannot represent it.'))
    elif edge < edge_margin_m:
        checks.append(_check('inside', 'block', 'Too close to the map edge',
                             f"The goal is {_metres(edge)} from the edge of the {size} grid (margin "
                             f'{_metres(edge_margin_m)}); the arrival area and route would leave the memory.'))
    else:
        checks.append(_check('inside', 'pass', 'Inside the map',
                             f'{_metres(edge)} from the edge of the {size} grid.'))

    # Window of cell centres around the goal (seen, free); cells outside the grid are unseen, never free.
    reach = max(arrival_radius_m, robot_radius_m, inflate_m)
    k = int(math.ceil(reach / res)) + 1
    offsets = np.arange(-k, k + 1)
    wi = np.broadcast_to(goal_cell[0] + offsets[:, None], (2 * k + 1, 2 * k + 1))
    wj = np.broadcast_to(goal_cell[1] + offsets[None, :], (2 * k + 1, 2 * k + 1))
    dist = np.hypot(lo[0] + wi * res - goal[0], lo[1] + wj * res - goal[1])
    in_grid = (wi >= 0) & (wi < n) & (wj >= 0) & (wj < n)
    window_support = np.full(dist.shape, np.nan)
    window_support[in_grid] = support[wi[in_grid], wj[in_grid]]
    window_seen = np.isfinite(window_support)

    # seen
    if not goal_in_grid:
        checks.append(_check('seen', 'warn', 'Not seen',
                             'The goal is outside the map, so the robot has not seen this spot.'))
    else:
        disc = dist <= arrival_radius_m
        fraction = int(np.count_nonzero(disc & window_seen)) / max(int(np.count_nonzero(disc)), 1)
        goal_seen = bool(observed[tuple(goal_cell)])
        area = f'{100 * fraction:.0f} % of the {_metres(arrival_radius_m)} arrival area seen'
        if not goal_seen or fraction < SEEN_WARN_FRACTION:
            what = 'the goal cell is unseen' if not goal_seen else 'most of the arrival area is unseen'
            checks.append(_check('seen', 'warn', 'Not seen yet',
                                 f'The robot has not seen this spot yet: {what} ({area}).'))
        else:
            checks.append(_check('seen', 'pass', 'Seen', f'Goal cell seen; {area}.'))

    # free (needs the route grid for the margin test)
    occ =route_occupancy(grid, step_over_m=step_over_m, inflate_m=inflate_m, grow_unknown_m=grow_unknown_m)
    if not goal_in_grid:
        checks.append(_check('free', 'warn', 'Not checked', 'The goal is outside the map; obstacles there are unknown.'))
    else:
        filled = np.nan_to_num(window_support, nan=0.0)
        window_tall = filled > step_over_m
        window_low = (filled > low_obstacle_m) & ~window_tall
        nearest_tall = float(dist[window_tall].min()) if window_tall.any() else math.inf
        near_low = window_low & (dist <= robot_radius_m)
        unseen_note = '' if observed[tuple(goal_cell)] else ' Only seen cells count; the goal cell itself is unseen.'
        if nearest_tall <= robot_radius_m:
            height = float(window_support[window_tall & (dist <= robot_radius_m)].max())
            checks.append(_check('free', 'block', 'Too close to an obstacle',
                                 f'Goal is {_metres(nearest_tall)} from an obstacle taller than the robot can step '
                                 f'over ({_metres(height)} high, step-over {_metres(step_over_m)}); the robot needs '
                                 f'{_metres(robot_radius_m)}.'))
        else:
            notes = []
            if occ[tuple(goal_cell)]:
                if nearest_tall <= inflate_m + 1e-9:
                    where = (f"Goal is {_metres(nearest_tall)} from an obstacle, inside the route's "
                             f'{_metres(inflate_m)} margin')
                else:
                    where = (f'Goal is next to unseen space beside an obstacle; the route grows seen obstacles '
                             f'{_metres(grow_unknown_m)} into unseen space and keeps {_metres(inflate_m)} from them')
                notes.append(f'{where}: the route ends at the nearest free cell and the planner approaches the goal '
                             'from there.')
            if near_low.any():
                height = float(window_support[near_low].max())
                d_low = float(dist[near_low].min())
                notes.append(f'A {_metres(height)} high obstacle is {_metres(d_low)} from the goal; the robot would '
                             'step over or onto it.')
            if notes:
                checks.append(_check('free', 'warn', 'Obstacle near the goal', ' '.join(notes) + unseen_note))
            else:
                checks.append(_check('free', 'pass', 'Free of obstacles',
                                     f'No seen obstacle within {_metres(max(inflate_m, robot_radius_m))} of the goal.'
                                     + unseen_note))

    # overhead: node.py ceiling_near, a square window of ceil(radius / res) cells. At the goal itself it blocks: a stand
    # there is deferred while the robot stays. The node evaluates it where it stands the robot up, anywhere inside the
    # arrival radius, so the ring out to radius + arrival radius warns (review M4).
    def ceiling_window(radius):
        k = int(np.ceil(radius / res))
        a0, a1 = max(goal_cell[0] - k, 0), min(goal_cell[0] + k + 1, n)
        b0, b1 = max(goal_cell[1] - k, 0), min(goal_cell[1] + k + 1, n)
        if a0 >= a1 or b0 >= b1:
            return None
        window = ceiling[a0:a1, b0:b1]
        ci, cj = np.nonzero(np.isfinite(window) & (window < head_height_m))
        if not len(ci):
            return None
        heights = window[ci, cj]
        reach = np.hypot(lo[0] + (ci + a0) * res - goal[0], lo[1] + (cj + b0) * res - goal[1])
        return float(heights.min()), float(reach.min())
    edge_note = lambda h: (" A ceiling this low is often the top edge of a table, box or pillar that the robot's map "
                           'files as overhead; node.py defers its stand all the same.' if h < 1.1 else '')
    inner = ceiling_window(overhead_radius_m) if goal_in_grid else None
    outer = ceiling_window(overhead_radius_m + arrival_radius_m) if goal_in_grid and inner is None else None
    if inner is not None:
        checks.append(_check('overhead', 'block', 'Low overhead obstacle',
                             f'An overhead obstacle {_metres(inner[0])} above the floor is {_metres(inner[1])} from the '
                             f'goal (head height {_metres(head_height_m)}): standing up there drives the head into it, '
                             'so the node defers the stand and the robot holds its last pose (it can still drift).' + edge_note(inner[0])))
    elif outer is not None:
        checks.append(_check('overhead', 'warn', 'Overhead obstacle near the arrival',
                             f'An overhead obstacle {_metres(outer[0])} above the floor is {_metres(outer[1])} from the '
                             f'goal: if the robot stands up on its side of the {_metres(arrival_radius_m)} arrival '
                             'radius, the node defers the stand until it moves clear.' + edge_note(outer[0])))
    elif not goal_in_grid:
        checks.append(_check('overhead', 'warn', 'Not checked', 'The goal is outside the map; overhead space is unknown.'))
    else:
        checks.append(_check('overhead', 'pass', 'No low overhead obstacle',
                             f'No overhead obstacle below {_metres(head_height_m)} seen within '
                             f'{_metres(overhead_radius_m + arrival_radius_m)} of the goal.'))

    # reachable
    path, path_m, unknown_fraction = None, None, None
    if robot is None:
        checks.append(_check('reachable', 'block', 'Robot position unknown',
                             'Reachability needs the robot position; it is not available.'))
    elif not _in_grid(cell_of(lo, res, robot), n):
        checks.append(_check('reachable', 'block', 'Robot outside the map',
                             'The robot is outside the planner memory, so no route can be planned on it.'))
    elif not goal_in_grid:
        checks.append(_check('reachable', 'block', 'Not reachable', 'The goal is outside the map.'))
    else:
        plan = plan_route(grid, robot, goal, step_over_m=step_over_m, inflate_m=inflate_m,
                          grow_unknown_m=grow_unknown_m, _occupancy=occ)
        coarse = (f' Searched at {_metres(plan["search_res_m"])} blocks (conservative).'
                  if plan['search_res_m'] > res + 1e-12 else '')
        if not plan['found']:
            checks.append(_check('reachable', 'block', 'No route',
                                 f"{plan['reason']}: the route keeps {_metres(inflate_m)} from obstacles taller than "
                                 f'{_metres(step_over_m)}; unseen space counts as free.' + coarse))
        else:
            path = plan['path_xy']
            path_m = float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum())
            samples = _sample_path(path, res)
            cells = cell_of(lo, res, samples) if len(samples) else np.empty((0, 2), dtype=int)
            inside = (cells >= 0).all(1) & (cells < n).all(1) if len(cells) else np.empty(0, dtype=bool)
            clipped = np.clip(cells, 0, n - 1)
            seen = np.zeros(len(cells), dtype=bool)
            if len(cells):
                seen[inside] = observed[clipped[inside, 0], clipped[inside, 1]]
            unknown_fraction = float(1.0 - seen.mean()) if len(cells) else 0.0
            notes = []
            if plan['start_shift_m']:
                notes.append(f"The robot stands inside the route's {_metres(inflate_m)} obstacle margin; as Flow's "
                             f"SensorRoute does, the route starts from the nearest free cell "
                             f"{_metres(plan['start_shift_m'])} away.")
            low_route = None
            if len(cells):
                under = ceiling[clipped[inside, 0], clipped[inside, 1]]
                under = under[np.isfinite(under) & (under < head_height_m)]
                if under.size:
                    low_route = float(under.min())
                    notes.append(f'The route passes under an overhead obstacle at {_metres(low_route)}; the policy must '
                                 'duck, and a stand (Stand, a lost LiDAR) there is deferred by the node.')
            if not plan.get('pruned', True):
                notes.append('Path shortening stopped at its work bound; the length is of the unshortened path.')
            summary = (f'Route {_metres(path_m)}; {100 * unknown_fraction:.0f} % of it crosses space the robot has '
                       'not seen.')
            if unknown_fraction > UNKNOWN_WARN_FRACTION:
                status, title = 'warn', 'Route crosses unseen space'
                notes.insert(0, 'The route treats unseen space as free.')
            elif low_route is not None:
                status, title = 'warn', 'Route passes under a low overhead obstacle'
            elif plan['start_shift_m']:
                status, title = 'warn', 'Reachable from inside the obstacle margin'
            else:
                status, title = 'pass', 'Reachable'
            checks.append(_check('reachable', status, title, ' '.join([summary, *notes]) + coarse))

    # distance
    straight_m = None if robot is None else float(np.linalg.norm(goal - robot))
    if straight_m is None:
        checks.append(_check('distance', 'warn', 'Distance unknown', 'The robot position is unknown.'))
    else:
        text = f'Straight {_metres(straight_m)}' + (f', route {_metres(path_m)}' if path_m is not None else '') + '.'
        walk = path_m if path_m is not None else straight_m
        if straight_m <= arrival_radius_m:
            checks.append(_check('distance', 'warn', 'Already there',
                                 text + f' The goal is inside the {_metres(arrival_radius_m)} arrival radius.'))
        elif max_distance_m is not None and walk > max_distance_m:
            checks.append(_check('distance', 'warn', 'Beyond the distance limit',
                                 text + f' The limit for this test is {_metres(max_distance_m)}.'))
        else:
            checks.append(_check('distance', 'pass', 'Distance', text))

    if tuple(c['id'] for c in checks) != CHECK_IDS:
        raise RuntimeError('goal check produced an incomplete check list')
    path_out = None if path is None else [[round(float(x), 4), round(float(y), 4)] for x, y in _decimate(path)]
    return {'ok': not any(c['status'] == 'block' for c in checks),
            'goal_xy': [float(goal[0]), float(goal[1])],
            'robot_xy': None if robot is None else [float(robot[0]), float(robot[1])],
            'checks': checks, 'straight_m': straight_m, 'path_m': path_m, 'path_xy': path_out,
            'unknown_fraction': unknown_fraction,
            'grid': {'basis': basis, 'res_m': res, 'observed_fraction': float(observed.mean())}}


# ----- Deploy additions: the passage width along a route, and the cells behind a block ---------------------------
# Used by the Deploy workspace's goal check (studio/deploy_link.py, docs/DEPLOY.md); check_goal above is unchanged.

GAP_REACH_M = 1.5          # sides are searched this far across the route; wider passages are not narrow
GAP_WARN_M = 1.0           # below this the route's 0.35 m margin leaves the 0.6 m body little room
GAP_SPACING_M = 0.05


def _ray_box_distances(origins, dirs, boxes):
    """Distance along each ray (origins, dirs: (k, 2), dirs unit) to each oriented box (k, m); inf for a miss and 0
    when the origin is inside. Slab method in each box's own frame."""
    centre = np.array([b['center_xy'] for b in boxes], dtype=np.float64)
    half = np.array([b['half_xy'] for b in boxes], dtype=np.float64)
    yaw = np.array([b['yaw'] for b in boxes], dtype=np.float64)
    c, s = np.cos(yaw)[None, :], np.sin(yaw)[None, :]
    dx = origins[:, None, 0] - centre[None, :, 0]
    dy = origins[:, None, 1] - centre[None, :, 1]
    ox, oy = c * dx + s * dy, -s * dx + c * dy
    vx = c * dirs[:, None, 0] + s * dirs[:, None, 1]
    vy = -s * dirs[:, None, 0] + c * dirs[:, None, 1]
    tmin = np.full(ox.shape, -np.inf)
    tmax = np.full(ox.shape, np.inf)
    hit = np.ones(ox.shape, dtype=bool)
    with np.errstate(divide='ignore', invalid='ignore'):
        for o, v, h in ((ox, vx, half[None, :, 0]), (oy, vy, half[None, :, 1])):
            flat = np.abs(v) < 1e-12
            hit &= ~(flat & (np.abs(o) > h))
            t1, t2 = (-h - o) / v, (h - o) / v
            lo_t, hi_t = np.where(flat, -np.inf, np.minimum(t1, t2)), np.where(flat, np.inf, np.maximum(t1, t2))
            tmin, tmax = np.maximum(tmin, lo_t), np.minimum(tmax, hi_t)
    hit &= tmax >= np.maximum(tmin, 0.0)
    return np.where(hit, np.maximum(tmin, 0.0), np.inf)


def route_gap(boxes, path_xy, *, step_over_m=0.25, head_height_m=1.35, reach_m=GAP_REACH_M, spacing_m=GAP_SPACING_M):
    """The narrowest free width across a route between boxes that block a walk (taller than step_over_m and lower
    than head_height_m at their underside), measured perpendicular to the route every spacing_m.

    A sample counts only when both sides hit a box within reach_m; samples inside a box are skipped (a twin box is
    a fit to the scan and can overlap the planned route a little). Returns None when no sample is bounded on both
    sides, else {width_m, at_xy (the route point), sides_xy [[left], [right]], left_m, right_m} in the frame of the
    inputs."""
    walls = [b for b in (boxes or []) if b['z_top'] > step_over_m and b['z_bottom'] < head_height_m]
    path = np.asarray(path_xy if path_xy is not None else [], dtype=np.float64)
    if not walls or path.ndim != 2 or len(path) < 2:
        return None
    points, dirs = [], []
    for a, b in zip(path[:-1], path[1:]):
        length = float(np.linalg.norm(b - a))
        if length < 1e-9:
            continue
        steps = max(1, int(math.ceil(length / spacing_m)))
        t = np.arange(steps + 1) / steps
        points.append(a + t[:, None] * (b - a))
        dirs.append(np.repeat(((b - a) / length)[None, :], steps + 1, axis=0))
    if not points:
        return None
    points, dirs = np.vstack(points), np.vstack(dirs)
    normals = np.stack([-dirs[:, 1], dirs[:, 0]], 1)
    left = _ray_box_distances(points, normals, walls)
    right = _ray_box_distances(points, -normals, walls)
    inside = ((left == 0) | (right == 0)).any(axis=1)
    left_m, right_m = left.min(axis=1), right.min(axis=1)
    bounded = ~inside & (left_m <= reach_m) & (right_m <= reach_m)
    if not bounded.any():
        return None
    width = np.where(bounded, left_m + right_m, np.inf)
    k = int(np.argmin(width))
    p, n = points[k], normals[k]
    return {'width_m': float(width[k]), 'at_xy': [float(p[0]), float(p[1])],
            'sides_xy': [[float(p[0] + n[0] * left_m[k]), float(p[1] + n[1] * left_m[k])],
                         [float(p[0] - n[0] * right_m[k]), float(p[1] - n[1] * right_m[k])]],
            'left_m': float(left_m[k]), 'right_m': float(right_m[k])}


def gap_check(gap, have_boxes=True, have_route=True, *, robot_radius_m=0.30, inflate_m=0.35, warn_m=GAP_WARN_M,
              reach_m=GAP_REACH_M):
    """The `gap` check row for a route_gap result: block narrower than the robot (2 x robot_radius_m), warn below
    warn_m, pass otherwise. Never passes when it could not be measured."""
    body = 2 * robot_radius_m
    if not have_boxes:
        return _check('gap', 'warn', 'Passage width not measured',
                      'The scan has no twin boxes to measure passages against.')
    if not have_route:
        return _check('gap', 'warn', 'Passage width not measured', 'There is no route to measure along.')
    if gap is None:
        return _check('gap', 'pass', 'No narrow passage',
                      f"No passage narrower than {_metres(2 * reach_m)} along the route between the scan twin's boxes.")
    width = gap['width_m']
    text = (f"The narrowest passage along the route is {_metres(width)} wide between the scan twin's boxes "
            f'({_metres(gap["left_m"])} left, {_metres(gap["right_m"])} right of the route).')
    if width < body:
        return _check('gap', 'block', 'Passage narrower than the robot',
                      text + f' The checks take the robot as {_metres(body)} wide (radius {_metres(robot_radius_m)}).')
    if width < warn_m:
        return _check('gap', 'warn', 'Narrow passage',
                      text + f' The route keeps {_metres(inflate_m)} from each side; below {_metres(warn_m)} the '
                      f'{_metres(body)} wide robot has less than {_metres((warn_m - body) / 2)} a side, so a start '
                      'offset or a twin box that is a little off becomes a touch. Rehearse it.')
    return _check('gap', 'pass', 'Passage width', text)


def blocking_cells(grid, result, robot_xy, goal_xy, *, gap=None, robot_radius_m=0.30, step_over_m=0.25,
                   inflate_m=0.35, overhead_radius_m=0.8, head_height_m=1.35, limit=200):
    """Cell centres (grid frame) behind each blocking check of a check_goal result (plus a blocking gap): tall cells
    at the goal (free), low ceilings over it (overhead), obstacles along the straight line when there is no route
    (reachable), the two sides of a passage narrower than the robot (gap). At most `limit` points."""
    support, ceiling, lo, res, n = _require_grid(grid)
    blocked = {c['id'] for c in result.get('checks', []) if c.get('status') == 'block'}
    goal = _xy(goal_xy, 'goal_xy')
    gi = cell_of(lo, res, goal)
    out = []

    def window(radius):
        k = int(np.ceil(radius / res))
        a0, a1 = max(gi[0] - k, 0), min(gi[0] + k + 1, n)
        b0, b1 = max(gi[1] - k, 0), min(gi[1] + k + 1, n)
        if a0 >= a1 or b0 >= b1:
            return None
        ii, jj = np.meshgrid(np.arange(a0, a1), np.arange(b0, b1), indexing='ij')
        return ii, jj

    if 'free' in blocked and (w := window(robot_radius_m)) is not None:
        ii, jj = w
        d = np.hypot(lo[0] + ii * res - goal[0], lo[1] + jj * res - goal[1])
        tall = np.nan_to_num(support[ii, jj], nan=0.0) > step_over_m
        out += [lo + np.array([i, j]) * res for i, j in zip(ii[tall & (d <= robot_radius_m)], jj[tall & (d <= robot_radius_m)])]
    if 'overhead' in blocked and (w := window(overhead_radius_m)) is not None:
        ii, jj = w
        c = ceiling[ii, jj]
        low = np.isfinite(c) & (c < head_height_m)
        out += [lo + np.array([i, j]) * res for i, j in zip(ii[low], jj[low])]
    if 'reachable' in blocked and robot_xy is not None and _in_grid(gi, n):
        robot = _xy(robot_xy, 'robot_xy')
        if _in_grid(cell_of(lo, res, robot), n):
            occ = np.nan_to_num(support, nan=0.0) > step_over_m
            ci, cj = np.nonzero(occ)
            if len(ci):
                cells = lo + np.stack([ci, cj], 1) * res
                seg = goal - robot
                t = np.clip(((cells - robot) @ seg) / max(float(seg @ seg), 1e-12), 0.0, 1.0)
                near = np.linalg.norm(cells - (robot + t[:, None] * seg), axis=1) <= inflate_m + robot_radius_m
                out += list(cells[near])
    if gap is not None and gap.get('width_m', math.inf) < 2 * robot_radius_m:
        out += [np.asarray(p, dtype=np.float64) for p in gap['sides_xy']]
    if not out:
        return []
    pts = np.unique(np.round(np.array(out, dtype=np.float64), 4), axis=0)
    return [[float(x), float(y)] for x, y in _decimate(pts, limit)]
