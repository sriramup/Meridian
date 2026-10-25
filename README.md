![Meridian](https://meridian-assets-tawny.vercel.app/meridian-banner-unroll.webp)

In fairytales, kings and queens are best remembered not by the crowns they wore, but by the kingdoms they built. 

But we are not living in the past. Now, it is our turn to *shape our world*.

Introducing **Meridian**, an agentic workspace for designing and simulating real cities.
---

![Inspiration](https://meridian-assets-tawny.vercel.app/inspiration-torn.webp)

If you have ever walked down Speedway in Austin in August, you know the feeling. You are constantly hopping between patches of shade under the trees, trying to avoid the Texas sun for just a little bit longer.

While this sounds like a small problem, it reveals a lot. The way we design our cities affects how hot our streets get, how easily water drains after a storm, how long it takes to get to class, and whether people can reach the places they need. Trees, building layouts, parks, and transportation all play a role in shaping these experiences.

We realized that many of these problems could be improved through better city planning. The challenge is that planning a city is complicated. Additionally, the stakes are massive:
- Approximately 45% of the world's 8.2 billion people lived in cities in 2025, according to [UN DESA's *World Urbanization Prospects 2025*](https://www.un.org/development/desa/pd/world-urbanization-prospects-2025).
- Nearly half of the local government respondents in [LGC's 2025 Confidence Survey](https://www.lgcplus.com/politics/service-reform/the-state-of-it-leaving-behind-the-legacy-29-01-2025/) identified outdated legacy systems as a barrier to adopting and using technology.
- The size of the US urban planning software market is estimated to be $3.9 billion, according to [IBISWorld's 2025 market research](https://www.ibisworld.com/united-states/market-research-reports/?entid=953).

![3.7B people live in cities · 49% of officials say legacy systems hold them back · $3.9B US urban planning market](https://meridian-assets-tawny.vercel.app/stats-v2.webp)

We wanted to make the planning process more visual, interactive, and accessible. Instead of manually jumping between mapping software, spreadsheets, engineering models, and design tools, what if we could make a change to a city, simulate its consequences, and explore alternatives in one workspace? What if we could describe a planning problem in plain English and have AI agents help us solve it?

That idea became **Meridian**, an agentic city planning and designing workspace.

---

![Features](https://meridian-assets-tawny.vercel.app/features-torn.webp)

Meridian is a 3D planning and simulation workspace for real cities. It allows you to explore a measured digital model of a city, redesign it by hand or with AI agents, and see how those changes affect the surrounding city.

### The Austin Model

Meridian starts with approximately 17 km² of central Austin, covering Downtown, the Capitol, UT Austin, East Austin, Rainey, Bouldin, and both banks of Lady Bird Lake.

**Our model includes:**
- 10,800 buildings, with LiDAR-derived heights for 93% of them.
- The street network with lane-by-lane cross-sections, intersections, and sidewalks.
- Building parcels, zoning rules, floor-area ratios, height limits, and Capitol View Corridors.
- Tree canopy, impervious surfaces, storm drains, and FEMA floodplains.
- Capital Metro routes and stops, along with the city's sidewalk and curb-ramp inventory.
- Census population, housing, employment, traffic counts, terrain, and weather data.

You can orbit around the city, fly to landmarks, explore streets at ground level, search for locations, and move through a day and night cycle with changing sunlight and illuminated windows.

We also built a blank 3 × 3 km sandbox, so you can experiment with an entirely new city instead of being limited to Austin.

### Manual and Agentic Design

You can redesign streets one component at a time, adding bike lanes, bus lanes, medians, rain gardens, wider sidewalks, and more. Meridian regenerates related street geometry and checks how the changes affect nearby buildings, parcels, trees, drainage infrastructure, and transit stops.

Buildings are just as flexible. We can create different architectural forms, add green roofs and setbacks, combine structures, and generate new buildings that respect zoning constraints.

For more complex projects, Meridian includes a library of **220+ configurable objects and design primitives**. These range from buildings, homes, schools, and utilities to parks, trees, sports fields, street furniture, and entire subdivision layouts.

You can also generate complete neighborhoods from a planning brief. By specifying population, housing, jobs, density, and facilities, we can lay out streets, civic spaces, blocks, and buildings in a single operation. The result can then be evaluated for things like connectivity, park access, school access, block size, and street standards.

One of the coolest features is sketch-to-city, which allows you to upload a photo of a bird's-eye sketch, a whiteboard drawing, or even an ingenious architectural plan you scribbled on a napkin. Our vision workflow converts the drawing into a structured plan that Meridian uses to construct a real district.

### Simulate the Consequences

Meridian is more than a city builder thanks to its simulation abilities. You can run various models against the edited city to explore how a design performs.

| Simulation | What we can investigate |
|---|---|
| Traffic | Congestion, traffic flow, intersection capacity, and changes throughout the day |
| Urban heat | Surface temperatures, building and tree shadows, pedestrian heat exposure, and shaded walking routes |
| Stormwater | Runoff from design storms and the benefits of rain gardens, green roofs, and retention features |
| Flooding | Potential inundation based on the city's terrain and connected low-lying areas |
| Cycling | Bike-stress levels, low-stress routes, and gaps in bicycle connectivity |
| Accessibility | Walking times to parks, groceries, schools, frequent transit, and other amenities |
| Emergency access | Fire and EMS response times relative to a four-minute response benchmark |
| Capacity and growth | Development potential under zoning rules and modeled redevelopment scenarios |

![Build the Platform Behind the Agent Track](https://meridian-assets-tawny.vercel.app/track-northmark-anim.webp)
### Our Agent

Instead of creating an AI chatbot that just suggests ideas about cities, we wanted agents that can actually do things. Our Agent feature is able to work on a city, use tools, inspect the results, and make real changes to the selected city design.

Meridian's agent workspace is built around a reusable execution platform. Rather than creating a completely separate implementation for every new AI capability, we give agents access to a shared world model and a registry of tools.

The platform supports:

- **Multiple concurrent agents:** Each session has its own conversation, history, mode, working region, approval flow, and ability to stop a run. Agents can investigate different planning questions while working with the same city.
- **Plan mode and Edit mode:** In Plan mode, editing tools only run as previews and return reports explaining the expected changes. In Edit mode, agents can commit approved changes.
- **Geographic work zones:** We can ask an agent to work within a specific block, district, intersection, or radius. Its changes are checked against that region before they are committed.
- **Coordinated editing:** Changes are serialized, tracked by session, and scoped so that one agent does not accidentally undo another agent's work. Agents are also warned by city changes since their last inspection.
- **Human approval:** Potentially destructive actions, such as demolishing historic buildings or removing more than 25 buildings, require approval.

We designed the platform so that its core tools operate directly on Meridian's world model rather than requiring a separate external service for every action. We can also test the full agent execution pipeline without model credentials or search credits by using a mock streaming model API and recorded search fixtures. Live model inference and live search still use their configured providers.

The result is a platform where new agents and capabilities can be added without reinventing the entire system, while edits remain inspectable, constrained, and reversible.

---

![Design](https://meridian-assets-tawny.vercel.app/design-torn.webp)

We built Meridian as a single-page, browser-based application with a shared city model underneath the editor, simulations, and AI agents. Our biggest architectural decision was to make all of them operate on the same underlying data and changesets. We broke the implementation into a handful of major systems: city data and geometry, rendering, simulation, agent execution, and live search.

![Best Use of SerpApi Track](https://meridian-assets-tawny.vercel.app/track-serpapi-anim.webp)
### SerpApi

For urban planning, census data and city GIS layers are useful, but they cannot tell us everything about current local businesses, recently announced developments, or the amenities surrounding a particular street. **SerpApi** gives Meridian a way to connect live information about the real world to our planning workspace.

We integrated Google Search, Google Maps, Google News, and Google Scholar through three agent tools:

**1. `web_search`**

Our agent can research questions that are not answered by the local city model. This includes population growth, household size, median income, rent, rainfall, water supply, local ordinances, transit facts, planning research, and recent development news.

Search results are normalized into compact responses containing facts, snippets, dates, and sources. The agent is instructed to cite figures, identify the relevant year, and acknowledge when a search does not provide a reliable answer instead of making something up. This helps us ground a proposed neighborhood design in real-world information rather than relying entirely on assumptions.

**2. `find_places`**

This is where search becomes particularly useful for urban planning. We can ask questions like *"Are there any grocery stores within a 10-minute walk of the Texas Capitol?"* The agent searches Google Maps, finds relevant locations, and converts their coordinates into Meridian's local map.

Instead of relying on straight-line distances, we calculate walking times over the actual street network using Dijkstra's shortest-path algorithm at the same walking speed used by our access model. The agent can then identify accessibility gaps, display nearby places as map pins, and help us understand which parts of a district are underserved.

**3. `import_places`**

With our opt-in import tool, discovered locations can be added to the city as points of interest in one reversible changeset. Once imported, those destinations can be counted by the walk-access and cycling models. 

This means live search results can actually become part of our planning analysis, instead of just extra information. For example, we can find nearby grocery stores or identify a gap in walking access, and rerun the accessibility model to compare the result.

**Engineering around a limited API budget**

We had a 1,000-credit SerpApi budget for the hackathon, so we made the integration more deliberate than a normal search bar. We built a server-side proxy to keep API keys out of the browser, restricted requests to approved engines and fields, normalized large responses into compact results, cached searches on disk, and deduplicated identical concurrent requests.

We also added a search toggle to the agent composer so users can deliberately request live research. Google Maps results appear with details like ratings, reviews, walking times, and map locations, with an option to add them to the simulated city.

Our goal was to make SerpApi a meaningful part of the planning workflow. It connects live external knowledge to the actual geometry, accessibility calculations, and decisions happening inside Meridian.

![Best Use of Gemini API Track](https://meridian-assets-tawny.vercel.app/track-gemini-anim.webp)
### Gemini

We used the Gemini API to interpret planning requests in plain English, reason about the changes needed to achieve them, and translate those decisions into actions the simulator can execute.

One of our most interesting uses of Gemini was our sketch-to-city workflow. Users can upload a photo of a bird's-eye drawing, whiteboard sketch, or rough neighborhood plan. Using Gemini's multimodal capabilities, we interpret the image and turn it into a structured plan describing streets, blocks, parks, bodies of water, rail lines, and other city features. We then validate that plan before a deterministic builder translates it into actual 3D geometry.

Gemini also supports the reasoning behind our agentic planning experience. Given a request, the model can help determine which tools to use, what parts of the city to inspect, and which operations are needed to work toward the user's goal. Rather than letting the model directly modify the map through free-form text, we use structured tool calls that pass through Meridian's validation and safety systems. Every edit produces an explicit changeset, allowing us to inspect, undo, and compare the results.

We also designed our agent architecture to handle different levels of complexity. A quick question about a location should not require the same amount of reasoning as generating an entire neighborhood. Our request router classifies tasks as quick, standard, or deep, allowing us to adjust model configuration, output limits, and execution budgets to suit each task.

### Architecture and Simulation

We built Meridian using Next.js, React, and TypeScript. The city itself is represented by an immutable world model with a spatial index, exact changesets, and support for scenario branching.

Geometry operations are cascade-aware. When we widen a road, the application does not simply draw a wider strip. It updates the relevant street cross-sections, curbs, intersections, parcels, buildings, and infrastructure, then reports any conflicts that cannot be resolved automatically.

Simulation models run in Web Workers on replayed scenario copies. This lets us compare alternative proposals without blocking the main editor or permanently changing the baseline city. For example, the heat model combines ERA5 weather, a four-meter land-cover raster, measured tree canopy, and building and tree shadows based on the sun's position. Stormwater uses NRCS TR-55 curve numbers and NOAA Atlas 14 design storms, while the traffic model uses trip rates, calibrated traffic gateways, and static user-equilibrium assignment.

### Rendering in the Browser

For rendering, we used MapLibre GL JS and deck.gl for the map and 3D scene, alongside custom GLSL shaders for building facades. Rather than constructing every window as separate geometry, the shader generates architectural details such as floor slabs, mullions, window patterns, roof materials, and illuminated windows.

We also implemented chunked scene streaming, level of detail, frustum culling, and an adaptive rendering budget. Nearby chunks load first, while lighter data for surrounding areas is prepared ahead of time. Instanced meshes help us render repeated library objects efficiently.

### Tech Stack

| Category | Technologies |
|---|---|
| Framework | Next.js 16, React 19, TypeScript |
| 3D rendering and maps | deck.gl, MapLibre GL JS, WebGL, custom GLSL shaders |
| UI and styling | Tailwind CSS v4, Radix UI, cmdk |
| State management | Zustand |
| AI agent platform | Model routing, structured tool calls, streaming responses, session management |
| Live research | SerpApi, Google Search, Google Maps, Google News, Google Scholar |
| City editing | Geometry operations, building massing, spatial indexing, exact changesets |
| Simulation and compute | TypeScript, Web Workers, GPU-based raster blending |
| Persistence | IndexedDB, localStorage, server-side caches and ledgers |
| Testing | Vitest, headless Chromium, mock streaming model API, recorded search fixtures |
| Hosting | Vercel |

Our city data combines OpenStreetMap, City of Austin GIS, LiDAR-derived building information, Travis Central Appraisal District, Census 2020, LEHD employment data, TxDOT traffic counts, Capital Metro, USGS terrain, and ERA5 weather data.

---

![Challenges](https://meridian-assets-tawny.vercel.app/challenges-torn.webp)

We faced a lot of setbacks in such a short timeframe. These were some of our major challenges:

**Balancing visual quality with performance**

We wanted to render a detailed city without completely cooking the browser. So, we struggled with balancing visual quality, geographic detail, and performance. We wanted Austin to look like a real city, not a collection of placeholder boxes, but rendering thousands of buildings, their facades, trees, and other objects at once is expensive.

We implemented lazy loading and chunked scene streaming so the application prioritizes the areas around the camera. We also used level-of-detail tiers, frustum culling, instanced meshes, and custom GPU shaders to avoid unnecessary geometry and rendering work. We had to be selective about what to render in detail and when. That tradeoff let us preserve the immersive experience.

**Saving state without losing our work**

The application has a lot of state to keep track of. We needed to preserve projects, scenarios, changesets, agent sessions, conversation history, work zones, and undo and redo operations.

We implemented project persistence through IndexedDB and session persistence through localStorage, along with explicit changeset history. Sessions can be restored when we reopen a project, and runs interrupted by a reload are marked as stopped instead of being treated as completed.

**Letting multiple agents work on the same city**

We wanted agents to operate concurrently, but concurrency creates some surprisingly difficult problems. One agent might be working from a preview while another changes the relevant street. A user might switch scenario branches while a long-running agent is still working.

We introduced a world lock, session-tagged changesets, scenario pinning, and checks for changes made since each agent last inspected the city. If an agent's assumptions become stale, it is informed rather than blindly continuing with an outdated plan. We also added approval flows for destructive operations and revalidate changes after approval, since the world may have changed while an agent was waiting.

---

![Accomplishments](https://meridian-assets-tawny.vercel.app/accomplishments-torn.webp)

We are proud that we managed to build such an ambitious product in a single day. The idea had been on our minds for a while, so finally tuning it into a reality was a huge milestone. We are especially proud of these features:

- **An AI agent that can actually edit a city:** We built agents that make real geometric changes, handle cascading effects, respect work zones, and produce reversible changesets instead of stopping at text-based suggestions.
- **Sketch-to-city:** We can take a photo of a neighborhood drawing and turn it into a structured, editable district. That was one of the features we were most excited to see come together.
- **Successful SerpApi integration:** None of us had used SerpApi before this project, so getting live search and Maps results to interact with the actual planning model was satisfying.
- **A UI we genuinely enjoyed designing:** We went with an old-atlas aesthetic rather than a generic dashboard. We wanted the workspace to feel like opening a map of a kingdom.

---

![Insights](https://meridian-assets-tawny.vercel.app/insights-torn.webp)

One of our biggest takeaways was that building a useful AI agent requires reliable tools, clear rules about what it can change, feedback about what happened, and a way to recover when something goes wrong.

We also learned just how interconnected cities are. It is easy to draw a road or add a building, but making the whole surrounding environment respond correctly is a much harder problem. The geometry, infrastructure, and simulations all need to agree about what the city actually looks like.

Another lesson was that speed and accuracy do not always have to fight each other. Caching, choosing the right amount of reasoning for each task, and keeping tool responses small can make a system faster without simply using a less capable model.

And finally, we learned that hackathon projects become much more interesting when we focus on the parts we actually care about. We could have built a simple chat interface that answered urban planning questions, but we felt like implementing an agent that could explore and redesign on its own. Meridian became much more ambitious because we kept asking ourselves what would be cool to try next.

---

![Future](https://meridian-assets-tawny.vercel.app/future-torn.webp)

We want Meridian to be able to support real planning projects beyond just one city. Our next steps include:

- **More cities:** Austin is our starting point, but we want to build data pipelines for additional locations so people can explore and redesign the places they actually live.
- **Better physical integration:** We want to improve our sketch-to-city workflow by moving it beyond 2D plans. We want to be able to generate structures from 3D visual input, not just bird's-eye view sketches.
- **Deeper simulations:** More detailed traffic microsimulation, signal timing, and better-calibrated heat models would help us evaluate designs more rigorously.
- **Shared planning projects:** We want teams of people and agents to collaborate on the same project, compare ideas, and develop proposals together.

---

Feel free to try out Meridian for yourself at [ge0.tech](https://ge0.tech)!
