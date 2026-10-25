// A fixed reading of the whiteboard sketch used in the demo (public/demo/sketch-whiteboard.jpg is
// that board, straightened to its drawn frame; these coordinates refer to it). When demo mode is on
// (NEXT_PUBLIC_MERIDIAN_DEMO_SKETCH, on unless "0"), readSketch returns this plan for any attached
// image instead of calling the vision route; see src/sketch/store.ts.

import { normalisePlan } from "./plan";

export const DEMO_SKETCH_IMAGE = "/demo/sketch-whiteboard.jpg";
export const DEMO_SKETCH_ASPECT = 1400 / 745;

export const DEMO_SKETCH_PLAN = normalisePlan({
 "is_plan": true,
 "title": "Mixed-use town centre",
 "description": "A whiteboard sketch of a town centre. Low-rise houses sit on the west side, mixed-use towers in the middle, and a mall, parking, park, high school and retail to the east, all along a main east-west boulevard.",
 "extent": {
  "width_m": 600,
  "height_m": 320,
  "basis": "block_sizes",
  "confidence": 0.4
 },
 "default_use": "mixed",
 "default_density": "medium",
 "north_deg": null,
 "streets": [
  {
   "class": "arterial",
   "points": [
    [
     0,
     0.53
    ],
    [
     1,
     0.53
    ]
   ],
   "weight": 4
  },
  {
   "class": "collector",
   "points": [
    [
     0.19,
     0
    ],
    [
     0.19,
     1
    ]
   ],
   "weight": 3
  },
  {
   "class": "collector",
   "points": [
    [
     0.27,
     0
    ],
    [
     0.27,
     1
    ]
   ],
   "weight": 3
  },
  {
   "class": "collector",
   "points": [
    [
     0.345,
     0
    ],
    [
     0.345,
     1
    ]
   ],
   "weight": 3
  },
  {
   "class": "collector",
   "points": [
    [
     0.59,
     0
    ],
    [
     0.59,
     0.53
    ]
   ],
   "weight": 3
  },
  {
   "class": "collector",
   "points": [
    [
     0.59,
     0.25
    ],
    [
     1,
     0.25
    ]
   ],
   "weight": 3
  },
  {
   "class": "local",
   "points": [
    [
     0.94,
     0.53
    ],
    [
     0.94,
     1
    ]
   ],
   "weight": 2
  }
 ],
 "blocks": [
  {
   "poly": [
    [
     0.03,
     0.03
    ],
    [
     0.15,
     0.03
    ],
    [
     0.15,
     0.45
    ],
    [
     0.03,
     0.45
    ]
   ],
   "use": "residential",
   "density": "low"
  },
  {
   "poly": [
    [
     0.03,
     0.55
    ],
    [
     0.15,
     0.55
    ],
    [
     0.15,
     0.97
    ],
    [
     0.03,
     0.97
    ]
   ],
   "use": "residential",
   "density": "low"
  },
  {
   "poly": [
    [
     0.36,
     0.02
    ],
    [
     0.555,
     0.02
    ],
    [
     0.555,
     0.47
    ],
    [
     0.36,
     0.47
    ]
   ],
   "use": "mixed",
   "density": "high",
   "label": "MIXED USE",
   "floors": 10
  },
  {
   "poly": [
    [
     0.62,
     0.02
    ],
    [
     0.81,
     0.02
    ],
    [
     0.81,
     0.2
    ],
    [
     0.62,
     0.2
    ]
   ],
   "use": "commercial",
   "label": "MALL"
  },
  {
   "poly": [
    [
     0.36,
     0.62
    ],
    [
     0.665,
     0.62
    ],
    [
     0.665,
     0.95
    ],
    [
     0.36,
     0.95
    ]
   ],
   "use": "mixed",
   "density": "high",
   "floors": 10
  },
  {
   "poly": [
    [
     0.665,
     0.63
    ],
    [
     0.8,
     0.63
    ],
    [
     0.8,
     0.95
    ],
    [
     0.665,
     0.95
    ]
   ],
   "use": "commercial",
   "label": "RETAIL"
  },
  {
   "poly": [
    [
     0.8,
     0.64
    ],
    [
     0.91,
     0.64
    ],
    [
     0.91,
     0.95
    ],
    [
     0.8,
     0.95
    ]
   ],
   "use": "mixed",
   "label": "MIXED USE"
  }
 ],
 "areas": [
  {
   "kind": "parking",
   "name": "Parking lot",
   "poly": [
    [
     0.81,
     0.02
    ],
    [
     0.98,
     0.02
    ],
    [
     0.98,
     0.18
    ],
    [
     0.81,
     0.18
    ]
   ]
  },
  {
   "kind": "park",
   "poly": [
    [
     0.62,
     0.3
    ],
    [
     0.77,
     0.3
    ],
    [
     0.77,
     0.47
    ],
    [
     0.62,
     0.47
    ]
   ]
  }
 ],
 "facilities": [
  {
   "kind": "mall",
   "label": "MALL",
   "at": [0.715, 0.11],
   "poly": [[0.62, 0.02], [0.81, 0.02], [0.81, 0.2], [0.62, 0.2]]
  },
  {
   "kind": "school",
   "label": "HIGH SCHOOL",
   "at": [
    0.87,
    0.39
   ],
   "poly": [
    [
     0.79,
     0.33
    ],
    [
     0.95,
     0.33
    ],
    [
     0.95,
     0.45
    ],
    [
     0.79,
     0.45
    ]
   ]
  }
 ],
 "transit": [],
 "notes": [
  "MALL",
  "Parking lot",
  "MIXED USE",
  "HIGH SCHOOL",
  "RETAIL"
 ]
});
