"""Scan to twin: a Studio box arena fitted to the robot's own map (node dump format). Pure numpy.

The twin is fitted geometry from perception, not measured truth: box faces sit where LiDAR returns landed
(CloudMemory pushes each return 3.5 cm past the surface), tops are the highest return seen and unseen space
stays empty. docs/NAVIGATE.md §6, docs/REAL_WORLD_DEPLOYMENT.md §5.4.

Layers follow Flow ``sensor_map.memory_boxes``:
- ground: observed support above ``obstacle_threshold_m`` (0.05 m) -> boxes from the floor (z_bottom 0)
  to the highest support in the box;
- overhead: finite ceilings (``isfinite & < 1e2``) -> slabs from the lowest underside, ``ceiling_thickness_m``
  (0.1 m) thick.

``method='rectangles'`` covers each layer cell-exactly with axis-aligned rectangles (the largest rectangle
first) whose cells share a height group: heights within ``height_tol_m`` of the group's lowest, and every
ground height above ``tall_m`` in one group, because the planner clips support at 0.8 m (Flow
``ego_map support_clip_m``) and per-cell wall tops vary with what the head LiDAR saw. One bounding box per
connected component (Flow's default ``split=None``) is avoided: on arenas with walls it becomes one box over
the whole course (memory_boxes docstring, round ST). ``method='source'`` uses the dump's own ``boxes``.
Components smaller than ``min_area_m2`` are dropped as isolated returns; beyond ``max_boxes`` the smallest
pieces are merged into a near neighbour (conservative: the merged box covers both) or, with none near, dropped.
Every such change is listed in ``warnings``.
"""
from __future__ import annotations

from collections import deque
import math

import numpy as np

from studio import goal_check
from studio.workbench import MAX_BOXES, point_status, validate_map, validate_presets

OBSTACLE_THRESHOLD_M = 0.05     # Flow memory_boxes obstacle_threshold_m
CEILING_THICKNESS_M = 0.1       # Flow memory_boxes ceiling_thickness_m
OVERHEAD_MIN_BOTTOM_M = 0.8     # Flow BoxPMap / CloudMemory overhead_min_bottom_m (truth layer split)
TALL_M = 0.8                    # Flow ego_map support_clip_m
STEP_OVER_M = 0.25              # Flow route step_over_m
CLEAR_START_M = 0.4
MERGE_GAP_M = 0.3
QUALITY_RES_M = 0.05
FOUND_FRACTION = 0.5
MAX_COORD_M = 50.0              # workbench.validate_map box centre bound
MIN_HALF_M = 0.01               # workbench.validate_map half extent bound
MAX_Z_M = 10.0


def _label4(mask):
    """4-connected components (scipy.ndimage.label default structure). Returns (labels, count)."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    n0, n1 = mask.shape
    count = 0
    for start in zip(*np.nonzero(mask)):
        if labels[start]:
            continue
        count += 1
        labels[start] = count
        queue = deque([start])
        while queue:
            i, j = queue.popleft()
            for a, b in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)):
                if 0 <= a < n0 and 0 <= b < n1 and mask[a, b] and not labels[a, b]:
                    labels[a, b] = count
                    queue.append((a, b))
    return labels, count


def _height_groups(values, tol, tall):
    """Group ids for 1-D heights: greedy from the lowest, each group spans at most ``tol``; heights above
    ``tall`` (when given) share one group."""
    groups = np.zeros(len(values), dtype=np.int32)
    order = np.argsort(values, kind='stable')
    group, base = 0, None
    for index in order:
        value = values[index]
        if tall is not None and value > tall:
            groups[index] = -1
            continue
        if base is None or value > base + tol + 1e-12:
            group += 1
            base = value
        groups[index] = group
    return groups


def _largest_rectangle(mask):
    """Largest all-True axis-aligned rectangle (i0, i1, j0, j1), inclusive; histogram method, first wins ties.
    ``mask`` is a list of row lists (plain Python is faster than numpy for these small windows)."""
    rows, cols = len(mask), len(mask[0])
    heights = [0] * cols
    best_area, best = 0, None
    for i in range(rows):
        row = mask[i]
        for j in range(cols):
            heights[j] = heights[j] + 1 if row[j] else 0
        stack = []
        for j in range(cols + 1):
            h = heights[j] if j < cols else 0
            start = j
            while stack and stack[-1][1] >= h:
                s, sh = stack.pop()
                area = sh * (j - s)
                if area > best_area:
                    best_area, best = area, (i - sh + 1, i, s, j - 1)
                start = s
            stack.append((start, h))
    return best


def _rectangles(mask):
    """Disjoint cell-exact cover of ``mask`` by repeatedly taking the largest remaining rectangle."""
    remaining = mask.copy()
    out = []
    while remaining.any():
        ii, jj = np.nonzero(remaining)
        i0, j0 = ii.min(), jj.min()
        window = remaining[i0:ii.max() + 1, j0:jj.max() + 1]
        a0, a1, b0, b1 = _largest_rectangle(window.tolist())
        out.append((i0 + a0, i0 + a1, j0 + b0, j0 + b1))
        remaining[i0 + a0:i0 + a1 + 1, j0 + b0:j0 + b1 + 1] = False
    return out


def _layer_rectangles(occupied, heights, res, *, tol, tall, min_area_m2):
    """[(i0, i1, j0, j1, cells_height_array)] for one layer, plus (dropped components, dropped area)."""
    labels, count = _label4(occupied)
    pieces, dropped, dropped_area = [], 0, 0.0
    for k in range(1, count + 1):
        component = labels == k
        cells = int(component.sum())
        if cells * res * res < min_area_m2 - 1e-12:
            dropped += 1
            dropped_area += cells * res * res
            continue
        ii, jj = np.nonzero(component)
        i0, i1, j0, j1 = ii.min(), ii.max(), jj.min(), jj.max()
        sub = component[i0:i1 + 1, j0:j1 + 1]
        sub_heights = heights[i0:i1 + 1, j0:j1 + 1]
        groups = np.zeros(sub.shape, dtype=np.int32)
        groups[sub] = _height_groups(sub_heights[sub], tol, tall)
        for group in np.unique(groups[sub]):
            for a0, a1, b0, b1 in _rectangles(sub & (groups == group)):
                pieces.append((i0 + a0, i0 + a1, j0 + b0, j0 + b1, sub_heights[a0:a1 + 1, b0:b1 + 1]))
    return pieces, dropped, dropped_area


def _box_from_cells(lo, res, i0, i1, j0, j1):
    low = np.array([i0, j0]) * res + lo - res / 2
    high = np.array([i1, j1]) * res + lo + res / 2
    centre, half = (low + high) / 2, (high - low) / 2
    return {'center_xy': [float(centre[0]), float(centre[1])],
            'half_xy': [max(float(half[0]), MIN_HALF_M), max(float(half[1]), MIN_HALF_M)], 'yaw': 0.0}


def _layer_of(box):
    return 'overhead' if box['z_bottom'] >= OVERHEAD_MIN_BOTTOM_M else 'ground'


def _footprint_bounds(box):
    """Axis-aligned bounds of a (possibly rotated) box footprint."""
    c, s = math.cos(box['yaw']), math.sin(box['yaw'])
    hx, hy = box['half_xy']
    ex, ey = abs(c) * hx + abs(s) * hy, abs(s) * hx + abs(c) * hy
    x, y = box['center_xy']
    return x - ex, y - ey, x + ex, y + ey


def _gap(a, b):
    ax0, ay0, ax1, ay1 = _footprint_bounds(a)
    bx0, by0, bx1, by1 = _footprint_bounds(b)
    return math.hypot(max(0.0, max(ax0, bx0) - min(ax1, bx1)), max(0.0, max(ay0, by0) - min(ay1, by1)))


def _area(box):
    return 4.0 * box['half_xy'][0] * box['half_xy'][1]


def _merge(a, b):
    ax0, ay0, ax1, ay1 = _footprint_bounds(a)
    bx0, by0, bx1, by1 = _footprint_bounds(b)
    x0, y0, x1, y1 = min(ax0, bx0), min(ay0, by0), max(ax1, bx1), max(ay1, by1)
    return {'center_xy': [(x0 + x1) / 2, (y0 + y1) / 2], 'half_xy': [(x1 - x0) / 2, (y1 - y0) / 2], 'yaw': 0.0,
            'z_bottom': min(a['z_bottom'], b['z_bottom']), 'z_top': max(a['z_top'], b['z_top'])}


def _limit_boxes(boxes, max_boxes, warnings):
    """Merge the smallest box into its nearest same-layer neighbour within MERGE_GAP_M, else drop it."""
    boxes = list(boxes)
    merged = dropped = 0
    dropped_area = 0.0
    while len(boxes) > max_boxes:
        smallest = min(range(len(boxes)), key=lambda k: (_area(boxes[k]), k))
        box = boxes.pop(smallest)
        layer = _layer_of(box)
        candidates = [(k, _gap(box, other)) for k, other in enumerate(boxes) if _layer_of(other) == layer]
        candidates = [(k, gap) for k, gap in candidates if gap <= MERGE_GAP_M]
        if candidates:
            k = min(candidates, key=lambda item: (item[1], item[0]))[0]
            boxes[k] = _merge(boxes[k], box)
            merged += 1
        else:
            dropped += 1
            dropped_area += _area(box)
    if merged:
        warnings.append(f'{merged} small pieces were merged into a neighbour to stay within {max_boxes} boxes; '
                        'merged boxes cover extra space (conservative).')
    if dropped:
        warnings.append(f'{dropped} small pieces with no neighbour within {MERGE_GAP_M:.1f} m were dropped to stay '
                        f'within {max_boxes} boxes ({dropped_area:.3f} m² of seen obstacle is missing from the twin).')
    return boxes


def _fit_rectangles(grid, *, threshold, height_tol_m, tall_m, min_area_m2, thickness, start, clear_start_m,
                    warnings):
    support, ceiling, lo, res, n = grid['support'], grid['ceiling'], np.asarray(grid['lo']), grid['res'], grid['n']
    filled = np.nan_to_num(support, nan=0.0)
    occupied = filled > threshold
    if clear_start_m > 0:
        ii, jj = np.mgrid[0:n, 0:n]
        near = np.hypot(lo[0] + ii * res - start[0], lo[1] + jj * res - start[1]) <= clear_start_m
        cleared = occupied & near & (filled <= STEP_OVER_M)
        if cleared.any():
            occupied &= ~cleared
            warnings.append(f'{int(cleared.sum())} low returns (up to {float(filled[cleared].max()):.2f} m) within '
                            f'{clear_start_m:.2f} m of the start were ignored: the robot stood there, so they are its '
                            'own legs or noise.')
    boxes = []
    ground, dropped_g, area_g = _layer_rectangles(occupied, filled, res, tol=height_tol_m, tall=tall_m,
                                                  min_area_m2=min_area_m2)
    for i0, i1, j0, j1, heights in ground:
        top = float(heights.max())
        if top > MAX_Z_M:
            warnings.append(f'A ground box {top:.2f} m high was capped at {MAX_Z_M:.0f} m.')
            top = MAX_Z_M
        boxes.append(dict(_box_from_cells(lo, res, i0, i1, j0, j1), z_bottom=0.0, z_top=top))
    overhead_mask = np.isfinite(ceiling) & (ceiling < 1e2)
    under = np.where(overhead_mask, ceiling, 0.0)
    overhead, dropped_o, area_o = _layer_rectangles(overhead_mask, under, res, tol=height_tol_m, tall=None,
                                                    min_area_m2=min_area_m2)
    for i0, i1, j0, j1, heights in overhead:
        cells = heights[np.isfinite(heights) & (heights > 0)]
        bottom = float(cells.min()) if cells.size else float(heights.min())
        if not 0.0 <= bottom <= MAX_Z_M - thickness:
            warnings.append(f'An overhead slab at {bottom:.2f} m is outside the arena height range and was skipped.')
            continue
        boxes.append(dict(_box_from_cells(lo, res, i0, i1, j0, j1), z_bottom=bottom, z_top=bottom + thickness))
    if dropped_g or dropped_o:
        warnings.append(f'{dropped_g + dropped_o} isolated fragments smaller than {min_area_m2:g} m² were ignored '
                        f'({area_g + area_o:.3f} m² in total).')
    return boxes


def _source_boxes(grid, warnings):
    if grid.get('boxes') is None:
        warnings.append('The map has no boxes field; the twin has no source boxes.')
        return []
    boxes = []
    for box in grid['boxes']:
        clean = {'center_xy': list(box['center_xy']), 'half_xy': [max(h, MIN_HALF_M) for h in box['half_xy']],
                 'yaw': math.atan2(math.sin(box['yaw']), math.cos(box['yaw'])),
                 'z_bottom': max(0.0, box['z_bottom']), 'z_top': min(box['z_top'], MAX_Z_M)}
        if clean['z_top'] <= clean['z_bottom']:
            warnings.append('A source box with no height above the floor was skipped.')
            continue
        boxes.append(clean)
    if not boxes:
        warnings.append('The map has no source boxes: Flow memory_boxes found no obstacle.')
    return boxes


def _grid_extent(grid):
    lo, res, n = np.asarray(grid['lo']), grid['res'], grid['n']
    return lo - res / 2, lo + (n - 1) * res + res / 2


def _clean_point(value, name):
    return [float(v) for v in goal_check._xy(value, name)]


def twin_from_grid(grid, *, start_xy, start_yaw_rad, goal_xy=None, label=None, method='rectangles',
                   min_area_m2=0.01, height_tol_m=0.05, max_boxes=128, truth_boxes=None,
                   obstacle_threshold_m=OBSTACLE_THRESHOLD_M, tall_m=TALL_M,
                   ceiling_thickness_m=CEILING_THICKNESS_M, clear_start_m=CLEAR_START_M):
    """Arena document (workbench ``validate_map`` / ``validate_presets`` compatible) fitted to ``grid``.

    Returns {schema_version, label, kind 'boxes', frame_id 'world', units 'm', boxes, bounds, presets,
    description, provenance, warnings, counts, quality}. ``presets`` holds one start/goal preset when the
    goal is given and both points are ``configured_free``; otherwise it is empty and ``warnings`` says why.
    ``quality`` is ``twin_quality`` against ``truth_boxes`` (None without them). ``tall_m`` None disables the
    tall height group. ``clear_start_m`` (rectangles only): ground returns no higher than the step-over height
    (0.25 m) within this distance of ``start_xy`` are not boxed, because the robot stood there during the scan
    (the recorded dumps carry its own leg returns: CloudMemory ``self_removed`` is 0); pass 0 when ``start_xy``
    is not where the robot stood. Taller returns are always kept.
    """
    goal_check._require_grid(grid)
    if method not in ('rectangles', 'source'):
        raise ValueError("method must be 'rectangles' or 'source'")
    start = _clean_point(start_xy, 'start_xy')
    yaw = goal_check._finite_float(start_yaw_rad, 'start_yaw_rad')
    yaw = math.atan2(math.sin(yaw), math.cos(yaw))
    goal = None if goal_xy is None else _clean_point(goal_xy, 'goal_xy')
    goal_check._finite_float(min_area_m2, 'min_area_m2', 0.0, 100.0)
    goal_check._finite_float(height_tol_m, 'height_tol_m', 0.0, 10.0)
    goal_check._finite_float(obstacle_threshold_m, 'obstacle_threshold_m', 0.0, 10.0)
    goal_check._finite_float(ceiling_thickness_m, 'ceiling_thickness_m', 0.01, 1.0)
    if tall_m is not None:
        goal_check._finite_float(tall_m, 'tall_m', 0.0, 10.0)
    goal_check._finite_float(clear_start_m, 'clear_start_m', 0.0, 5.0)
    if isinstance(max_boxes, bool) or not isinstance(max_boxes, int) or not 1 <= max_boxes <= MAX_BOXES:
        raise ValueError(f'max_boxes must be an integer in [1, {MAX_BOXES}]')
    warnings = []
    if method == 'rectangles':
        boxes = _fit_rectangles(grid, threshold=obstacle_threshold_m, height_tol_m=height_tol_m, tall_m=tall_m,
                                min_area_m2=min_area_m2, thickness=ceiling_thickness_m, start=start,
                                clear_start_m=clear_start_m, warnings=warnings)
    else:
        boxes = _source_boxes(grid, warnings)
    fitted = len(boxes)
    outside = [b for b in boxes if max(abs(v) for v in b['center_xy']) > MAX_COORD_M]
    if outside:
        warnings.append(f'{len(outside)} boxes more than {MAX_COORD_M:.0f} m from the world origin were dropped '
                        '(arena limit).')
        boxes = [b for b in boxes if b not in outside]
    if len(boxes) > max_boxes:
        boxes = _limit_boxes(boxes, max_boxes, warnings)
    # Bounds: the map extent, grown to contain what validate_map checks (centre ± half diagonal) and the preset.
    low, high = _grid_extent(grid)
    xs, ys = [low[0], high[0], start[0]], [low[1], high[1], start[1]]
    if goal is not None:
        xs.append(goal[0])
        ys.append(goal[1])
    for box in boxes:
        radius = math.hypot(*box['half_xy'])
        xs.extend([box['center_xy'][0] - radius, box['center_xy'][0] + radius])
        ys.extend([box['center_xy'][1] - radius, box['center_xy'][1] + radius])
    centre = [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2]
    half = [max((max(xs) - min(xs)) / 2, 0.5), max((max(ys) - min(ys)) / 2, 0.5)]  # validate_map needs extent
    bounds = {'min': [float(centre[0] - half[0]), float(centre[1] - half[1])],
              'max': [float(centre[0] + half[0]), float(centre[1] + half[1])]}
    basis = grid.get('basis') or goal_check.DEFAULT_BASIS
    label = label if label is not None else f'Scan twin · {basis}'[:100]
    observed = goal_check.observed_mask(grid)
    counts = {'ground': sum(_layer_of(b) == 'ground' for b in boxes),
              'overhead': sum(_layer_of(b) == 'overhead' for b in boxes), 'fitted': fitted}
    document = {'schema_version': 1, 'label': label, 'kind': 'boxes', 'frame_id': 'world', 'units': 'm',
                'boxes': boxes, 'bounds': bounds, 'presets': [],
                'description': (f'Fitted from the {basis} ({method}): {counts["ground"]} ground boxes, '
                                f'{counts["overhead"]} overhead slabs. Perception-derived geometry; unseen space '
                                'is empty. Correct it in the arena editor before relying on it.'),
                'provenance': {'source': grid.get('source') or 'in-memory grid', 'sha256': grid.get('sha256'),
                               'basis': basis, 'method': method, 'res_m': grid['res'],
                               'observed_fraction': float(observed.mean()),
                               'classification': 'fitted_from_perception',
                               'frame': "The map's frame is used as the arena world frame (identity).",
                               'parameters': {'min_area_m2': min_area_m2, 'height_tol_m': height_tol_m,
                                              'max_boxes': max_boxes, 'obstacle_threshold_m': obstacle_threshold_m,
                                              'tall_m': tall_m, 'ceiling_thickness_m': ceiling_thickness_m,
                                              'clear_start_m': clear_start_m if method == 'rectangles' else None,
                                              'merge_gap_m': MERGE_GAP_M}},
                'warnings': warnings, 'counts': counts, 'quality': None}
    data = validate_map(document)  # the document must load as an arena; raises if the fit broke a limit
    status = point_status(data, start)
    if status['status'] != 'configured_free':
        warnings.append(f"No preset: the start {status['reason'].lower()}.")
    elif goal is not None:
        goal_status = point_status(data, goal)
        if goal_status['status'] != 'configured_free':
            warnings.append(f"No preset: the goal {goal_status['reason'].lower()}.")
        elif math.dist(start, goal) < 0.2:
            warnings.append('No preset: start and goal are less than 0.2 m apart.')
        else:
            document['presets'] = validate_presets([{'label': 'Scan start to goal', 'start_xy': start,
                                                     'start_yaw_rad': yaw, 'goal_xy': goal}], data)
    if truth_boxes is not None:
        document['quality'] = twin_quality(boxes, truth_boxes, grid)
    return document


# ----- fit quality against the true boxes of a simulation ----------------------------------------------------

def _raster(grid, step=QUALITY_RES_M):
    """Raster cell centres over the map extent and their observed flag (nearest map cell)."""
    lo, res, n = np.asarray(grid['lo']), grid['res'], grid['n']
    if abs(res - step) < 1e-9:
        xs, ys = lo[0] + np.arange(n) * res, lo[1] + np.arange(n) * res
    else:
        low, high = _grid_extent(grid)
        xs = np.arange(low[0] + step / 2, high[0], step)
        ys = np.arange(low[1] + step / 2, high[1], step)
    ix = np.clip(np.round((xs - lo[0]) / res).astype(int), 0, n - 1)
    iy = np.clip(np.round((ys - lo[1]) / res).astype(int), 0, n - 1)
    support, ceiling = grid['support'], grid['ceiling']
    seen = ~np.isnan(support) | ~np.isnan(ceiling)
    return xs, ys, seen[np.ix_(ix, iy)]


def _footprint(box, xs, ys):
    """Raster cells whose centre lies inside the box footprint (rotated boxes supported)."""
    mask = np.zeros((len(xs), len(ys)), dtype=bool)
    x0, y0, x1, y1 = _footprint_bounds(box)
    a0, a1 = np.searchsorted(xs, x0 - 1e-9), np.searchsorted(xs, x1 + 1e-9, side='right')
    b0, b1 = np.searchsorted(ys, y0 - 1e-9), np.searchsorted(ys, y1 + 1e-9, side='right')
    if a0 >= a1 or b0 >= b1:
        return mask
    px, py = np.meshgrid(xs[a0:a1], ys[b0:b1], indexing='ij')
    c, s = math.cos(-box['yaw']), math.sin(-box['yaw'])
    dx, dy = px - box['center_xy'][0], py - box['center_xy'][1]
    local_x, local_y = c * dx - s * dy, s * dx + c * dy
    mask[a0:a1, b0:b1] = ((np.abs(local_x) <= box['half_xy'][0] + 1e-9)
                          & (np.abs(local_y) <= box['half_xy'][1] + 1e-9))
    return mask


def _clean_truth(boxes):
    if isinstance(boxes, dict):
        boxes = boxes.get('boxes')
    if not isinstance(boxes, list):
        raise ValueError('truth boxes must be a list (or {"boxes": [...]})')
    return [goal_check._clean_box(box, index) for index, box in enumerate(boxes)]


def twin_quality(twin_boxes, truth_boxes, grid):
    """Fit quality of twin boxes against a simulation's true boxes, judged only where the map saw anything.

    Footprints are rasterized at 5 cm and restricted to observed cells (support or ceiling recorded): an
    obstacle face the LiDAR never saw cannot be fitted. Returns {occupancy_iou, true_boxes_found,
    true_boxes_total, missed_area_m2, extra_area_m2, height_error_m, extra_unobserved_area_m2, layers, per_box,
    basis}. A true box is found when twin boxes of its layer (ground / overhead, split at z_bottom 0.8 m) cover
    at least half of its observed footprint; its height error compares the top (ground) or the underside
    (overhead) with the overlapping twin boxes' highest top / lowest underside. ``occupancy_iou`` is None when
    neither footprint has an observed cell.
    """
    goal_check._require_grid(grid)
    twin = _clean_truth(list(twin_boxes))
    truth = _clean_truth(truth_boxes)
    xs, ys, seen = _raster(grid)
    cell_area = (xs[1] - xs[0]) * (ys[1] - ys[0]) if len(xs) > 1 and len(ys) > 1 else QUALITY_RES_M ** 2
    twin_masks = [_footprint(b, xs, ys) for b in twin]
    truth_masks = [_footprint(b, xs, ys) for b in truth]
    empty = np.zeros(seen.shape, dtype=bool)

    def union(masks, boxes, layer=None):
        out = empty.copy()
        for mask, box in zip(masks, boxes):
            if layer is None or _layer_of(box) == layer:
                out |= mask
        return out

    def scores(t_union, w_union):
        inter = int(np.count_nonzero(t_union & w_union & seen))
        joint = int(np.count_nonzero((t_union | w_union) & seen))
        return {'iou': inter / joint if joint else None,
                'missed_area_m2': float(np.count_nonzero(t_union & ~w_union & seen) * cell_area),
                'extra_area_m2': float(np.count_nonzero(w_union & ~t_union & seen) * cell_area)}

    t_all, w_all = union(truth_masks, truth), union(twin_masks, twin)
    overall = scores(t_all, w_all)
    layers = {layer: scores(union(truth_masks, truth, layer), union(twin_masks, twin, layer))
              for layer in ('ground', 'overhead')}
    per_box, errors = [], []
    for index, (box, mask) in enumerate(zip(truth, truth_masks)):
        layer = _layer_of(box)
        observed_cells = mask & seen
        n_observed = int(np.count_nonzero(observed_cells))
        same = [(b, m) for b, m in zip(twin, twin_masks) if _layer_of(b) == layer]
        covered = empty.copy()
        for _, m in same:
            covered |= m
        fraction = int(np.count_nonzero(covered & observed_cells)) / n_observed if n_observed else 0.0
        found = n_observed > 0 and fraction >= FOUND_FRACTION
        overlapping = [b for b, m in same if np.any(m & observed_cells)]
        if found and overlapping:
            if layer == 'ground':
                truth_h, twin_h = box['z_top'], max(b['z_top'] for b in overlapping)
            else:
                truth_h, twin_h = box['z_bottom'], min(b['z_bottom'] for b in overlapping)
            errors.append(abs(twin_h - truth_h))
        else:
            truth_h = box['z_top'] if layer == 'ground' else box['z_bottom']
            twin_h = None
        per_box.append({'index': index, 'layer': layer, 'observed_area_m2': float(n_observed * cell_area),
                        'covered_fraction': float(fraction), 'found': bool(found),
                        'truth_height_m': float(truth_h), 'twin_height_m': None if twin_h is None else float(twin_h),
                        'height_basis': 'top' if layer == 'ground' else 'underside'})
    return {'occupancy_iou': overall['iou'],
            'true_boxes_found': sum(row['found'] for row in per_box), 'true_boxes_total': len(truth),
            'missed_area_m2': overall['missed_area_m2'], 'extra_area_m2': overall['extra_area_m2'],
            'height_error_m': float(np.median(errors)) if errors else None,
            'extra_unobserved_area_m2': float(np.count_nonzero(w_all & ~t_all & ~seen) * cell_area),
            'layers': layers, 'per_box': per_box,
            'basis': ('5 cm footprint raster restricted to observed map cells; true boxes from the simulation, '
                      'twin boxes fitted from perception')}
