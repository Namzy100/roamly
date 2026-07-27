import {
  TRIP_PLAN_SCHEMA_VERSION,
  TripPlanSchema,
  segmentDurationMinutes,
  tripNightCount,
  type BackupOption,
  type ItineraryDay,
  type ItineraryItem,
  type PlaceCategory,
  type TravelMode,
  type TravelSegment,
  type TripPlace,
  type TripPlan,
  type TripRequest,
} from "@/lib/schemas";

/**
 * The single deterministic sample plan: Dubai → Lisbon, five days, balanced
 * pace, culture and food.
 *
 * Every value here is a literal. Nothing is randomised and nothing reads the
 * clock, so the plan is byte-identical on the server and the client and across
 * reloads — a requirement for both hydration correctness and reviewability.
 *
 * Place names and coordinates are real so the map placeholder is geographically
 * honest, but the identifiers are deliberately prefixed `mock_` rather than
 * shaped like Google Place IDs. Nothing downstream can mistake this for live
 * Places data, and ratings shown against real businesses are clearly labelled
 * as sample data in the UI.
 *
 * `estimatedCost` is always the total for the whole party, not per traveller.
 */

const MOCK_TRIP_ID = "demo-lisbon-5d";

const REQUEST: TripRequest = {
  departureCity: "Dubai",
  destination: "Lisbon",
  startDate: "2026-09-12",
  endDate: "2026-09-16",
  budget: 3200,
  currency: "EUR",
  travelers: 2,
  vibes: ["culture", "food"],
  pace: "balanced",
  accommodation: "boutique",
  dietary: ["no-pork"],
  interests: [
    "museums",
    "architecture",
    "history",
    "street-food",
    "viewpoints",
    "coffee",
  ],
  notes:
    "First time in Portugal. We would rather go deep on a few neighbourhoods than tick off a list. Happy to walk, and we love a good pastry.",
};

/**
 * Maps the sample data's descriptive labels onto the controlled category
 * vocabulary introduced in Phase 3.
 *
 * The descriptive label is kept as `categoryLabel` — "Coffee roastery" says more
 * than "cafe", and losing it would make the demo poorer for no gain. The controlled
 * `category` is what the map, the pool validator and any future provider query use.
 */
const LABEL_TO_CATEGORY: Record<string, PlaceCategory> = {
  "Art museum": "museum",
  Bookshop: "shopping",
  "Botanical garden": "garden",
  "Boutique hotel": "hotel",
  Cape: "viewpoint",
  Cathedral: "place_of_worship",
  "Coffee roastery": "cafe",
  "Contemporary Portuguese": "restaurant",
  "Creative complex": "shopping",
  "Flea market": "market",
  "Food hall": "market",
  "Food market": "market",
  Garden: "garden",
  "Historic square": "attraction",
  "Historical estate": "historic_site",
  "Historical landmark": "historic_site",
  Monastery: "place_of_worship",
  Monument: "monument",
  Museum: "museum",
  Palace: "historic_site",
  "Pastry shop": "cafe",
  "Peruvian restaurant": "restaurant",
  "Petiscos bar": "bar",
  "Portuguese restaurant": "restaurant",
  "Seafood restaurant": "restaurant",
  Tasca: "restaurant",
  Viewpoint: "viewpoint",
};

/**
 * Builds a sample place.
 *
 * `source.provider` is `"mock"` and carries **no** OSM element identity — pool
 * validation rejects a mock record that claims any, so the sample data can never be
 * mistaken for verified OpenStreetMap results.
 */
function place(
  slug: string,
  name: string,
  categoryLabel: string,
  address: string,
  lat: number,
  lng: number,
  rating: number | null,
  userRatingCount: number | null,
  priceLevel: TripPlace["priceLevel"] | null,
  editorialSummary: string | null,
): TripPlace {
  const category = LABEL_TO_CATEGORY[categoryLabel];
  if (!category) {
    throw new Error(`No category mapping for sample label "${categoryLabel}"`);
  }

  const placeId = `mock_${slug}`;

  // Optional fields are omitted rather than set to null: absent means absent.
  return {
    placeId,
    name,
    category,
    categoryLabel,
    address,
    coordinates: { lat, lng },
    source: {
      provider: "mock",
      canonicalId: placeId,
      attribution: "Sample data — not sourced from any provider",
    },
    ...(rating !== null ? { rating } : {}),
    ...(userRatingCount !== null ? { userRatingCount } : {}),
    ...(priceLevel !== null ? { priceLevel } : {}),
    ...(editorialSummary !== null ? { editorialSummary } : {}),
  };
}

const PLACES = {
  fabricaCoffee: place(
    "fabrica_coffee",
    "Fábrica Coffee Roasters",
    "Coffee roastery",
    "R. das Portas de Santo Antão 136, 1150-269 Lisboa",
    38.7169,
    -9.1409,
    4.5,
    3820,
    "PRICE_LEVEL_INEXPENSIVE",
    "Small-batch roaster pouring one of the city's better flat whites.",
  ),
  cathedral: place(
    "se_de_lisboa",
    "Sé de Lisboa",
    "Cathedral",
    "Lg. da Sé, 1100-585 Lisboa",
    38.71,
    -9.133,
    4.5,
    18450,
    "PRICE_LEVEL_INEXPENSIVE",
    "Romanesque cathedral rebuilt after the 1755 earthquake.",
  ),
  tiNatercia: place(
    "ti_natercia",
    "Ti-Natércia",
    "Portuguese restaurant",
    "R. Escolas Gerais 54, 1100-193 Lisboa",
    38.7128,
    -9.1279,
    4.4,
    2140,
    "PRICE_LEVEL_MODERATE",
    "Tiny Alfama dining room known for its cooking and its owner in equal measure.",
  ),
  portasDoSol: place(
    "portas_do_sol",
    "Miradouro das Portas do Sol",
    "Viewpoint",
    "Lg. Portas do Sol, 1100-411 Lisboa",
    38.7122,
    -9.13,
    4.7,
    41200,
    "PRICE_LEVEL_FREE",
    "Terrace looking out over Alfama's rooftops to the Tejo.",
  ),
  ramiro: place(
    "cervejaria_ramiro",
    "Cervejaria Ramiro",
    "Seafood restaurant",
    "Av. Alm. Reis 1 H, 1150-007 Lisboa",
    38.7215,
    -9.1355,
    4.4,
    32700,
    "PRICE_LEVEL_EXPENSIVE",
    "Institution for garlic prawns and crab, with a queue to match.",
  ),
  jeronimos: place(
    "mosteiro_jeronimos",
    "Mosteiro dos Jerónimos",
    "Monastery",
    "Praça do Império 1400-206 Lisboa",
    38.6979,
    -9.2065,
    4.7,
    58900,
    "PRICE_LEVEL_MODERATE",
    "Manueline monastery and the high-water mark of Portuguese Gothic.",
  ),
  pasteisBelem: place(
    "pasteis_de_belem",
    "Pastéis de Belém",
    "Pastry shop",
    "R. de Belém 84-92, 1300-085 Lisboa",
    38.6975,
    -9.2033,
    4.5,
    64100,
    "PRICE_LEVEL_INEXPENSIVE",
    "The original custard tart, made to a recipe from 1837.",
  ),
  torreBelem: place(
    "torre_de_belem",
    "Torre de Belém",
    "Historical landmark",
    "Av. Brasília, 1400-038 Lisboa",
    38.6916,
    -9.216,
    4.6,
    47300,
    "PRICE_LEVEL_MODERATE",
    "Riverside fort that once guarded the entrance to the harbour.",
  ),
  maat: place(
    "maat",
    "MAAT",
    "Art museum",
    "Av. Brasília, 1300-598 Lisboa",
    38.6957,
    -9.1936,
    4.4,
    12800,
    "PRICE_LEVEL_MODERATE",
    "Museum of Art, Architecture and Technology under a walkable wave roof.",
  ),
  cevicheria: place(
    "a_cevicheria",
    "A Cevicheria",
    "Peruvian restaurant",
    "R. Dom Pedro V 129, 1250-096 Lisboa",
    38.716,
    -9.153,
    4.4,
    9600,
    "PRICE_LEVEL_EXPENSIVE",
    "Kiko Martins' ceviche counter, octopus overhead, no reservations.",
  ),
  regaleira: place(
    "quinta_da_regaleira",
    "Quinta da Regaleira",
    "Historical estate",
    "R. Barbosa du Bocage 5, 2710-567 Sintra",
    38.7965,
    -9.3961,
    4.7,
    51200,
    "PRICE_LEVEL_MODERATE",
    "Romantic estate of grottoes, follies and the initiation well.",
  ),
  tascantiga: place(
    "tascantiga",
    "Tascantiga",
    "Petiscos bar",
    "Esc. Fonte da Pipa 4, 2710-524 Sintra",
    38.7943,
    -9.3893,
    4.4,
    3300,
    "PRICE_LEVEL_MODERATE",
    "Terraced petiscos spot on the climb above Sintra's old town.",
  ),
  pena: place(
    "palacio_da_pena",
    "Palácio Nacional da Pena",
    "Palace",
    "Estrada da Pena, 2710-609 Sintra",
    38.7876,
    -9.3904,
    4.6,
    89400,
    "PRICE_LEVEL_MODERATE",
    "Ferdinand II's Romanticist palace on the highest ridge of the Serra.",
  ),
  timeOut: place(
    "time_out_market",
    "Time Out Market Lisboa",
    "Food hall",
    "Av. 24 de Julho 49, 1200-479 Lisboa",
    38.7071,
    -9.1459,
    4.4,
    78600,
    "PRICE_LEVEL_MODERATE",
    "Curated food hall inside the old Mercado da Ribeira.",
  ),
  manteigaria: place(
    "manteigaria_chiado",
    "Manteigaria",
    "Pastry shop",
    "R. do Loreto 2, 1200-108 Lisboa",
    38.7099,
    -9.1435,
    4.6,
    28900,
    "PRICE_LEVEL_INEXPENSIVE",
    "Custard tarts pulled from the oven in front of you, all day.",
  ),
  azulejo: place(
    "museu_do_azulejo",
    "Museu Nacional do Azulejo",
    "Museum",
    "R. Me. Deus 4, 1900-312 Lisboa",
    38.7248,
    -9.115,
    4.6,
    14200,
    "PRICE_LEVEL_MODERATE",
    "Five centuries of Portuguese tile inside a 16th-century convent.",
  ),
  feiraDaLadra: place(
    "feira_da_ladra",
    "Feira da Ladra",
    "Flea market",
    "Campo de Santa Clara, 1100-472 Lisboa",
    38.7157,
    -9.1249,
    4.2,
    11700,
    "PRICE_LEVEL_FREE",
    "Open-air flea market held on Tuesdays and Saturdays.",
  ),
  zeDosCornos: place(
    "ze_dos_cornos",
    "Zé dos Cornos",
    "Tasca",
    "Bq. dos Fanqueiros 5, 1100-231 Lisboa",
    38.7126,
    -9.1354,
    4.5,
    6400,
    "PRICE_LEVEL_INEXPENSIVE",
    "Long shared tables and a grill that has not changed in decades.",
  ),
  avillez: place(
    "cantinho_do_avillez",
    "Cantinho do Avillez",
    "Contemporary Portuguese",
    "R. Duques de Bragança 7, 1200-162 Lisboa",
    38.7097,
    -9.1444,
    4.5,
    8900,
    "PRICE_LEVEL_EXPENSIVE",
    "José Avillez's most relaxed room, in the heart of Chiado.",
  ),
  gulbenkian: place(
    "museu_gulbenkian",
    "Museu Calouste Gulbenkian",
    "Art museum",
    "Av. de Berna 45A, 1067-001 Lisboa",
    38.7376,
    -9.1543,
    4.7,
    22400,
    "PRICE_LEVEL_MODERATE",
    "One collector's museum, from Egyptian relief to Lalique glass.",
  ),
  estufaFria: place(
    "estufa_fria",
    "Estufa Fria",
    "Botanical garden",
    "Parque Eduardo VII, 1070-051 Lisboa",
    38.728,
    -9.154,
    4.5,
    9100,
    "PRICE_LEVEL_INEXPENSIVE",
    "Cool greenhouse of ferns, palms and streams in Parque Eduardo VII.",
  ),
  campoOurique: place(
    "mercado_campo_ourique",
    "Mercado de Campo de Ourique",
    "Food market",
    "R. Coelho da Rocha 104, 1350-075 Lisboa",
    38.7166,
    -9.1668,
    4.4,
    15600,
    "PRICE_LEVEL_MODERATE",
    "Neighbourhood market with a tighter, more local food court.",
  ),
  comercio: place(
    "praca_do_comercio",
    "Praça do Comércio",
    "Historic square",
    "Praça do Comércio, 1100-148 Lisboa",
    38.7075,
    -9.1364,
    4.7,
    92300,
    "PRICE_LEVEL_FREE",
    "The city's riverfront front door, rebuilt after the earthquake.",
  ),
  hotel: place(
    "hotel_santiago_alfama",
    "Santiago de Alfama",
    "Boutique hotel",
    "R. de Santiago 10-14, 1100-494 Lisboa",
    38.7113,
    -9.1305,
    4.7,
    1240,
    "PRICE_LEVEL_EXPENSIVE",
    "Fifteenth-century palace turned nineteen-room hotel in Alfama.",
  ),
  // Places used only as backup options.
  santaCatarina: place(
    "miradouro_santa_catarina",
    "Miradouro de Santa Catarina",
    "Viewpoint",
    "R. de Santa Catarina, 1200-401 Lisboa",
    38.7104,
    -9.149,
    4.5,
    19800,
    "PRICE_LEVEL_FREE",
    "Sunset terrace above Cais do Sodré, busker soundtrack included.",
  ),
  saoVicente: place(
    "sao_vicente_de_fora",
    "Mosteiro de São Vicente de Fora",
    "Monastery",
    "Lg. de São Vicente, 1100-572 Lisboa",
    38.715,
    -9.1272,
    4.6,
    8700,
    "PRICE_LEVEL_MODERATE",
    "Mannerist monastery whose roof gives one of the widest city views.",
  ),
  coachMuseum: place(
    "museu_dos_coches",
    "Museu Nacional dos Coches",
    "Museum",
    "Av. da Índia 136, 1300-300 Lisboa",
    38.6961,
    -9.1997,
    4.5,
    16900,
    "PRICE_LEVEL_MODERATE",
    "Royal carriages, gilded to a degree that has to be seen.",
  ),
  lxFactory: place(
    "lx_factory",
    "LX Factory",
    "Creative complex",
    "R. Rodrigues de Faria 103, 1300-501 Lisboa",
    38.7016,
    -9.1786,
    4.5,
    43800,
    "PRICE_LEVEL_MODERATE",
    "Print works turned shops, bookshop and restaurants under the bridge.",
  ),
  monserrate: place(
    "palacio_de_monserrate",
    "Palácio de Monserrate",
    "Palace",
    "Estrada de Monserrate, 2710-405 Sintra",
    38.7924,
    -9.4189,
    4.7,
    12400,
    "PRICE_LEVEL_MODERATE",
    "Quieter Sintra palace with a botanical park worth the walk.",
  ),
  cabo: place(
    "cabo_da_roca",
    "Cabo da Roca",
    "Cape",
    "Estrada do Cabo da Roca, 2705-001 Colares",
    38.7805,
    -9.4989,
    4.7,
    38200,
    "PRICE_LEVEL_FREE",
    "The westernmost point of continental Europe, and windy with it.",
  ),
  bertrand: place(
    "livraria_bertrand",
    "Livraria Bertrand Chiado",
    "Bookshop",
    "R. Garrett 73-75, 1200-309 Lisboa",
    38.7105,
    -9.142,
    4.5,
    7200,
    "PRICE_LEVEL_MODERATE",
    "Operating since 1732, and it has the certificate to prove it.",
  ),
  cristoRei: place(
    "cristo_rei",
    "Santuário de Cristo Rei",
    "Monument",
    "Av. Cristo Rei, 2800-058 Almada",
    38.6785,
    -9.1712,
    4.6,
    27400,
    "PRICE_LEVEL_INEXPENSIVE",
    "Across the river, with the best head-on view of the bridge.",
  ),
  gulbenkianGarden: place(
    "jardim_gulbenkian",
    "Jardim Calouste Gulbenkian",
    "Garden",
    "Av. de Berna 45, 1067-001 Lisboa",
    38.7368,
    -9.1533,
    4.7,
    11300,
    "PRICE_LEVEL_FREE",
    "Modernist garden of ponds and shade wrapped around the museum.",
  ),
} satisfies Record<string, TripPlace>;

/**
 * A sample travel leg — always an **estimate**, never a routed one.
 *
 * These figures were written by hand for the demo. They are plausible and they
 * are not measured, and since Phase 4 the schema can say so: `status:
 * "estimated"` with `provider: "mock"`, a stated basis and a disclaimer the UI
 * renders. Nothing here may claim `status: "routed"` — that arm requires
 * provider geometry and a `fetchedAt`, which sample data has no honest way to
 * supply.
 *
 * This is also why the eight `TRANSIT` legs below are still legal: transit is
 * expressible as an estimate and is never routable, which is exactly the
 * distinction the union encodes.
 */
function segment(
  from: TripPlace,
  to: TripPlace,
  mode: TravelMode,
  durationMinutes: number,
  distanceMeters: number,
  note: string | null = null,
): TravelSegment {
  return {
    id: `seg_${from.placeId}__${to.placeId}`,
    fromPlaceId: from.placeId,
    toPlaceId: to.placeId,
    note,
    status: "estimated",
    provider: "mock",
    mode,
    estimatedDurationMinutes: durationMinutes,
    estimatedDistanceMeters: distanceMeters,
    basis: "Sample itinerary data — written by hand, not measured",
    confidence: "low",
    disclaimer:
      "Estimated travel time. Not routed, and not based on live conditions.",
  };
}

/** An item before `buildDay` assigns its id and order. */
type ItemDraft = Omit<ItineraryItem, "id" | "order">;

/**
 * `status` and `locked` are optional here so the 23 literals below need not repeat them.
 *
 * `locked` joined `status` in Phase 8, for the same reason and with the same default: the sample
 * trip has no traveller behind it, so nothing in it is pinned. Anyone opening the sample can lock a
 * stop themselves, and the field starts doing its job from that moment.
 */
type ItemInput = Omit<ItemDraft, "status" | "locked"> & {
  status?: ItineraryItem["status"];
  locked?: boolean;
};

function item(input: ItemInput): ItemDraft {
  return {
    ...input,
    status: input.status ?? "confirmed",
    locked: input.locked ?? false,
  };
}

/** Assigns stable ids and order from position, so the data stays readable. */
function buildDay(
  input: Omit<ItineraryDay, "items" | "dayTotal" | "totalTravelMinutes"> & {
    items: ItemDraft[];
  },
): ItineraryDay {
  const items: ItineraryItem[] = input.items.map((entry, index) => ({
    ...entry,
    // Placeless items still need a stable id; fall back to the ordinal.
    id: `d${input.dayNumber}_i${index + 1}_${entry.place?.placeId ?? "noplace"}`,
    order: index,
  }));

  return {
    dayNumber: input.dayNumber,
    date: input.date,
    theme: input.theme,
    summary: input.summary,
    backups: input.backups,
    items,
    dayTotal: round(items.reduce((sum, i) => sum + i.estimatedCost, 0)),
    // `segmentDurationMinutes` rather than a field read: a segment's duration
    // lives under a different name in each arm of the union, and an unavailable
    // leg has none at all. It returns null there, and null contributes nothing —
    // an unroutable leg must not silently read as zero minutes of travel.
    totalTravelMinutes: items.reduce(
      (sum, i) =>
        sum + (i.travelToNext ? (segmentDurationMinutes(i.travelToNext) ?? 0) : 0),
      0,
    ),
  };
}

function backup(
  slug: string,
  title: string,
  kind: BackupOption["kind"],
  reason: string,
  place: TripPlace,
  estimatedCost: number,
): BackupOption {
  return { id: `bk_${slug}`, title, kind, reason, place, estimatedCost };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const DAYS: ItineraryDay[] = [
  buildDay({
    dayNumber: 1,
    date: "2026-09-12",
    theme: "Alfama, slowly",
    summary:
      "A deliberately short first day. You land mid-morning, drop bags in Alfama, and stay inside a ten-minute radius of the hotel so the jet lag has somewhere to go.",
    items: [
      item({
        kind: "meal",
        mealType: "breakfast",
        title: "Land, drop bags, first coffee",
        rationale:
          "Fifteen minutes from the hotel and open early, so it works before check-in opens at 15:00. A flat white here is the fastest way to reset after a seven-hour flight.",
        place: PLACES.fabricaCoffee,
        startTime: "10:30",
        endTime: "11:30",
        estimatedCost: 14,
        costNote: "Two coffees and a pastry",
        bookingRequired: false,
        tip: "The roastery sells beans at the counter if you want to take some home.",
        travelToNext: segment(
          PLACES.fabricaCoffee,
          PLACES.cathedral,
          "WALK",
          16,
          1200,
          "Downhill through Baixa, then a short climb to the cathedral.",
        ),
      }),
      item({
        kind: "attraction",
        mealType: null,
        title: "Sé de Lisboa",
        rationale:
          "The right first monument: it explains the 1755 earthquake, which in turn explains why the rest of the city looks the way it does. Twenty minutes inside is enough on day one.",
        place: PLACES.cathedral,
        startTime: "12:00",
        endTime: "12:45",
        estimatedCost: 10,
        costNote: "€5 each including the cloister",
        bookingRequired: false,
        tip: "The cloister excavation is the quieter half and usually empty.",
        travelToNext: segment(
          PLACES.cathedral,
          PLACES.tiNatercia,
          "WALK",
          11,
          800,
          "Follow the 28 tram line up Rua das Escolas Gerais.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "lunch",
        title: "Lunch at Ti-Natércia",
        rationale:
          "Nine tables and no menu translation, which is the point. Ask for the grilled fish of the day rather than the pork dishes, which keeps it comfortably within your no-pork preference.",
        place: PLACES.tiNatercia,
        startTime: "13:00",
        endTime: "14:30",
        estimatedCost: 52,
        costNote: "Two mains, wine, couvert",
        bookingRequired: true,
        tip: "Turning up without a booking rarely works. Call the morning of.",
        travelToNext: segment(
          PLACES.tiNatercia,
          PLACES.portasDoSol,
          "WALK",
          6,
          450,
        ),
      }),
      item({
        kind: "viewpoint",
        mealType: null,
        title: "Portas do Sol at golden hour",
        rationale:
          "The orientation view. From here you can see every rooftop you will walk under for the next four days, which makes the rest of the trip legible.",
        place: PLACES.portasDoSol,
        startTime: "15:00",
        endTime: "16:00",
        estimatedCost: 0,
        costNote: null,
        bookingRequired: false,
        tip: "The kiosk terrace charges a premium for the view. The wall beside it is free.",
        travelToNext: segment(
          PLACES.portasDoSol,
          PLACES.ramiro,
          "TRANSIT",
          18,
          1900,
          "Tram 28 to Martim Moniz, then a five-minute walk.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "dinner",
        title: "Prawns at Cervejaria Ramiro",
        rationale:
          "Your food-focused vibe earns one classic on night one. Shellfish, bread, beer, no ceremony — and it is the meal you will compare everything else to.",
        place: PLACES.ramiro,
        startTime: "20:00",
        endTime: "21:45",
        estimatedCost: 90,
        costNote: "Garlic prawns, clams, tiger prawns, beer",
        bookingRequired: false,
        tip: "Take a ticket and wait. Arriving at 19:30 costs about 20 minutes; 21:00 costs an hour.",
        travelToNext: null,
      }),
    ],
    backups: [
      backup(
        "d1_sao_vicente",
        "São Vicente de Fora roof",
        "attraction",
        "If the cathedral is closed for a service, this is eight minutes away and the roof view is better.",
        PLACES.saoVicente,
        16,
      ),
      backup(
        "d1_santa_catarina",
        "Miradouro de Santa Catarina",
        "viewpoint",
        "A different sunset if Portas do Sol is shoulder-to-shoulder with tour groups.",
        PLACES.santaCatarina,
        0,
      ),
    ],
  }),

  buildDay({
    dayNumber: 2,
    date: "2026-09-13",
    theme: "Belém and the river",
    summary:
      "One tram ride west and the scale changes: monastery, tower, and a museum on the water. Belém rewards an early start more than anywhere else in the city.",
    items: [
      item({
        kind: "attraction",
        mealType: null,
        title: "Mosteiro dos Jerónimos, at opening",
        rationale:
          "The single best building in Lisbon and the reason to be out by nine. By 11:00 the cloister queue is 40 minutes; at 09:30 it is five.",
        place: PLACES.jeronimos,
        startTime: "09:30",
        endTime: "11:15",
        estimatedCost: 24,
        costNote: "€12 each for the cloister",
        bookingRequired: true,
        tip: "Buy online the night before. The church itself is free and separate from the cloister queue.",
        travelToNext: segment(
          PLACES.jeronimos,
          PLACES.pasteisBelem,
          "WALK",
          4,
          300,
        ),
      }),
      item({
        kind: "meal",
        mealType: "snack",
        title: "Pastéis de Belém",
        rationale:
          "Four minutes from the cloister and the original of the thing you have eaten copies of. Worth doing once, in the tiled back rooms rather than at the takeaway counter.",
        place: PLACES.pasteisBelem,
        startTime: "11:20",
        endTime: "12:15",
        estimatedCost: 12,
        costNote: "Four tarts and two coffees",
        bookingRequired: false,
        tip: "Ignore the street queue — it is for takeaway. Walk in and ask for a table.",
        travelToNext: segment(
          PLACES.pasteisBelem,
          PLACES.torreBelem,
          "WALK",
          15,
          1200,
          "Along the waterfront past the Padrão dos Descobrimentos.",
        ),
      }),
      item({
        kind: "attraction",
        mealType: null,
        title: "Torre de Belém",
        rationale:
          "Small, and the stair is a single-file bottleneck, so it suits the flat post-lunch hour rather than a prime slot. The Manueline stonework outside is the real draw.",
        place: PLACES.torreBelem,
        startTime: "13:00",
        endTime: "14:15",
        estimatedCost: 16,
        costNote: "€8 each",
        bookingRequired: false,
        tip: "If the queue is past the causeway, photograph it from the lawn and spend the time at MAAT instead.",
        travelToNext: segment(
          PLACES.torreBelem,
          PLACES.maat,
          "WALK",
          18,
          1500,
        ),
      }),
      item({
        kind: "attraction",
        mealType: null,
        title: "MAAT and its roof",
        rationale:
          "A deliberate change of register after two 16th-century monuments — contemporary architecture you can walk over, with the river on both sides.",
        place: PLACES.maat,
        startTime: "14:45",
        endTime: "16:30",
        estimatedCost: 22,
        costNote: "€11 each, both buildings",
        bookingRequired: false,
        tip: "The roof walk is free and open even when the galleries are between exhibitions.",
        travelToNext: segment(
          PLACES.maat,
          PLACES.cevicheria,
          "TRANSIT",
          32,
          6100,
          "Train to Cais do Sodré, then the Glória funicular up to Príncipe Real.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "dinner",
        title: "Ceviche in Príncipe Real",
        rationale:
          "Seafood again but nothing like last night — bright, acidic, Peruvian-Portuguese. No reservations, so the 20:00 door is the one to aim for.",
        place: PLACES.cevicheria,
        startTime: "20:00",
        endTime: "21:30",
        estimatedCost: 84,
        costNote: "Two ceviches, one to share, pisco sours",
        bookingRequired: false,
        tip: "Twelve seats. If it is full, put your name down and wait at a bar on Rua Dom Pedro V.",
        travelToNext: null,
      }),
    ],
    backups: [
      backup(
        "d2_coches",
        "Museu Nacional dos Coches",
        "attraction",
        "Indoors and five minutes from Jerónimos if the forecast turns.",
        PLACES.coachMuseum,
        18,
      ),
      backup(
        "d2_lx",
        "LX Factory",
        "experience",
        "Swap MAAT for this if you would rather browse and drink than look at art.",
        PLACES.lxFactory,
        20,
      ),
    ],
  }),

  buildDay({
    dayNumber: 3,
    date: "2026-09-14",
    theme: "Sintra, on one ticket",
    summary:
      "The one day out of the city. Two sites only — attempting a third is how Sintra days go wrong — and back in Lisbon in time for a market dinner.",
    items: [
      item({
        kind: "attraction",
        mealType: null,
        title: "Quinta da Regaleira first",
        rationale:
          "Counter-programming: everyone rides the bus straight up to Pena, so going to Regaleira first buys you the initiation well nearly to yourself.",
        place: PLACES.regaleira,
        startTime: "09:15",
        endTime: "11:45",
        estimatedCost: 30,
        costNote: "€15 each",
        bookingRequired: true,
        tip: "It is a 10-minute walk from Sintra station, uphill but easy. Skip the tuk-tuk touts.",
        travelToNext: segment(
          PLACES.regaleira,
          PLACES.tascantiga,
          "WALK",
          14,
          1000,
          "Back down towards the old town and up Escadinhas da Fonte da Pipa.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "lunch",
        title: "Petiscos above the old town",
        rationale:
          "Positioned between the two palaces so you are not eating at a Pena kiosk. Small plates keep the stop to an hour, which the afternoon needs.",
        place: PLACES.tascantiga,
        startTime: "12:00",
        endTime: "13:15",
        estimatedCost: 48,
        costNote: "Five petiscos and a bottle of vinho verde",
        bookingRequired: false,
        tip: "The terrace tables are worth a ten-minute wait over the indoor ones.",
        travelToNext: segment(
          PLACES.tascantiga,
          PLACES.pena,
          "TRANSIT",
          25,
          3400,
          "Bus 434 from the old town up to the palace gate.",
        ),
      }),
      item({
        kind: "attraction",
        mealType: null,
        title: "Palácio da Pena, late slot",
        rationale:
          "A 14:30 entry is deliberate: the coach parties thin after 15:30, and the light on the terrace is far better than at midday.",
        place: PLACES.pena,
        startTime: "14:30",
        endTime: "17:00",
        estimatedCost: 40,
        costNote: "€20 each, park and palace",
        bookingRequired: true,
        tip: "Your ticket has a timed entry to the interior. The park around it has no time limit.",
        travelToNext: segment(
          PLACES.pena,
          PLACES.timeOut,
          "TRANSIT",
          78,
          28000,
          "Bus down to Sintra station, then the Lisbon train to Cais do Sodré.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "dinner",
        title: "Time Out Market, low effort",
        rationale:
          "After nine hours out, a food hall is the correct answer — no booking, no commitment, and it is a two-minute walk from the train that brings you back.",
        place: PLACES.timeOut,
        startTime: "19:45",
        endTime: "21:00",
        estimatedCost: 56,
        costNote: "Two mains from separate counters, drinks",
        bookingRequired: false,
        tip: "Find a table first, then send one person to queue. It fills up after 20:00.",
        travelToNext: null,
      }),
    ],
    backups: [
      backup(
        "d3_monserrate",
        "Palácio de Monserrate",
        "attraction",
        "Swap for Pena if the queue is unmanageable — quieter, and the park is better.",
        PLACES.monserrate,
        24,
      ),
      backup(
        "d3_cabo",
        "Cabo da Roca",
        "viewpoint",
        "If you finish Sintra early and want the Atlantic, it is 40 minutes by bus.",
        PLACES.cabo,
        0,
      ),
    ],
  }),

  buildDay({
    dayNumber: 4,
    date: "2026-09-15",
    theme: "Tiles, junk and one proper dinner",
    summary:
      "A Tuesday, which is the reason this day exists in this slot: Feira da Ladra only runs Tuesdays and Saturdays, and it pairs naturally with the tile museum east of the centre.",
    items: [
      item({
        kind: "meal",
        mealType: "breakfast",
        title: "Manteigaria, standing up",
        rationale:
          "The counter comparison to Belém, and the better tart by most local accounts. Five minutes, standing, espresso and cinnamon.",
        place: PLACES.manteigaria,
        startTime: "09:15",
        endTime: "09:45",
        estimatedCost: 9,
        costNote: "Three tarts, two espressos",
        bookingRequired: false,
        tip: "A bell rings when a fresh tray comes out. Wait for it.",
        travelToNext: segment(
          PLACES.manteigaria,
          PLACES.azulejo,
          "TRANSIT",
          28,
          4200,
          "Bus 794 along the river to Igreja Madre de Deus.",
        ),
      }),
      item({
        kind: "attraction",
        mealType: null,
        title: "Museu Nacional do Azulejo",
        rationale:
          "The museum that makes the rest of the city readable — you will start noticing tile panels on every façade afterwards. It is also the strongest single match to your architecture interest.",
        place: PLACES.azulejo,
        startTime: "10:30",
        endTime: "12:30",
        estimatedCost: 20,
        costNote: "€10 each",
        bookingRequired: false,
        tip: "Do not miss the 23-metre panorama of pre-earthquake Lisbon on the top floor.",
        travelToNext: segment(
          PLACES.azulejo,
          PLACES.feiraDaLadra,
          "TRANSIT",
          16,
          2100,
        ),
      }),
      item({
        kind: "experience",
        mealType: null,
        title: "Feira da Ladra",
        rationale:
          "Tuesdays only. Not a shopping stop so much as the most unfiltered hour in the city — tiles, tin, and a great deal that is frankly rubbish.",
        place: PLACES.feiraDaLadra,
        startTime: "13:00",
        endTime: "14:15",
        estimatedCost: 0,
        costNote: "Bring cash if you intend to buy",
        bookingRequired: false,
        tip: "Single antique tiles sell for a few euros at the Campo de Santa Clara end.",
        travelToNext: segment(
          PLACES.feiraDaLadra,
          PLACES.zeDosCornos,
          "WALK",
          17,
          1400,
          "Downhill through Alfama into Baixa.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "lunch",
        title: "Late lunch at Zé dos Cornos",
        rationale:
          "A working tasca where you share a table with strangers. Order the grilled chicken or the bacalhau — both sit comfortably outside the pork side of the menu.",
        place: PLACES.zeDosCornos,
        startTime: "14:30",
        endTime: "15:45",
        estimatedCost: 36,
        costNote: "Two mains, house wine",
        bookingRequired: false,
        tip: "Cash preferred, and the kitchen stops around 15:00 on quiet days.",
        travelToNext: segment(
          PLACES.zeDosCornos,
          PLACES.avillez,
          "WALK",
          14,
          1000,
        ),
      }),
      item({
        kind: "meal",
        mealType: "dinner",
        title: "Cantinho do Avillez",
        rationale:
          "The one properly composed meal of the trip, held back to the last full evening. Same kitchen philosophy as Avillez's tasting rooms at a third of the price.",
        place: PLACES.avillez,
        startTime: "20:00",
        endTime: "22:00",
        estimatedCost: 96,
        costNote: "Two courses each, wine pairing by the glass",
        bookingRequired: true,
        tip: "Book two weeks ahead for a 20:00 table; 22:00 tables open up at short notice.",
        travelToNext: null,
      }),
    ],
    backups: [
      backup(
        "d4_bertrand",
        "Livraria Bertrand Chiado",
        "experience",
        "Ten minutes from dinner and open late if the market underwhelms.",
        PLACES.bertrand,
        25,
      ),
      backup(
        "d4_cristo_rei",
        "Cristo Rei and the ferry",
        "viewpoint",
        "A ferry across the Tejo if you would rather be outdoors than in a museum.",
        PLACES.cristoRei,
        14,
      ),
    ],
  }),

  buildDay({
    dayNumber: 5,
    date: "2026-09-16",
    theme: "One last museum, then the airport",
    summary:
      "Bags stay with the hotel. Everything today is north of the centre and close to the airport road, so a 19:40 flight needs no rushing.",
    items: [
      item({
        kind: "attraction",
        mealType: null,
        title: "Museu Calouste Gulbenkian",
        rationale:
          "Saved for last on purpose: it is the collection you can walk out of at any point without feeling short-changed, which is what a departure day needs.",
        place: PLACES.gulbenkian,
        startTime: "09:45",
        endTime: "12:00",
        estimatedCost: 28,
        costNote: "€14 each, founder's collection",
        bookingRequired: false,
        tip: "The Lalique room at the end is the one people remember. Do not rush the last gallery.",
        travelToNext: segment(
          PLACES.gulbenkian,
          PLACES.estufaFria,
          "WALK",
          13,
          1000,
        ),
      }),
      item({
        kind: "experience",
        mealType: null,
        title: "Estufa Fria",
        rationale:
          "Twenty minutes of shade and running water between a museum and a flight. Low effort, and almost nobody who is not local goes.",
        place: PLACES.estufaFria,
        startTime: "12:15",
        endTime: "13:15",
        estimatedCost: 6,
        costNote: "€3 each",
        bookingRequired: false,
        tip: "Enter from the top of Parque Eduardo VII — the lower gate is often shut.",
        travelToNext: segment(
          PLACES.estufaFria,
          PLACES.campoOurique,
          "TRANSIT",
          24,
          3200,
          "Metro to Rato, then tram 28 west.",
        ),
      }),
      item({
        kind: "meal",
        mealType: "lunch",
        title: "Last lunch at Campo de Ourique",
        rationale:
          "The residential answer to Time Out — same format, a fraction of the tourists. A market lunch also means no booking to make on a travel day.",
        place: PLACES.campoOurique,
        startTime: "13:45",
        endTime: "15:00",
        estimatedCost: 40,
        costNote: "Two mains, dessert, wine",
        bookingRequired: false,
        tip: "The steak sandwich counter at the back is the local order.",
        travelToNext: segment(
          PLACES.campoOurique,
          PLACES.comercio,
          "TRANSIT",
          22,
          3600,
          "Tram 28 down to Praça do Comércio.",
        ),
      }),
      item({
        kind: "viewpoint",
        mealType: null,
        title: "Praça do Comércio, then the airport",
        rationale:
          "A twenty-minute full stop on the river before you go. From here the Aeroporto metro is 25 minutes with one change, which leaves a comfortable margin for a 19:40 flight.",
        place: PLACES.comercio,
        startTime: "15:30",
        endTime: "16:15",
        estimatedCost: 0,
        costNote: null,
        bookingRequired: false,
        tip: "Collect bags from the hotel by 16:45 to be airside with two hours to spare.",
        travelToNext: null,
      }),
    ],
    backups: [
      backup(
        "d5_gulbenkian_garden",
        "Gulbenkian garden only",
        "experience",
        "If the museum feels like too much on a travel day, the garden is free and next door.",
        PLACES.gulbenkianGarden,
        0,
      ),
      backup(
        "d5_time_out",
        "Time Out Market again",
        "meal",
        "Closer to the hotel than Campo de Ourique if you are running behind.",
        PLACES.timeOut,
        44,
      ),
    ],
  }),
];

const NIGHTS = tripNightCount(REQUEST);
const NIGHTLY_RATE = 165;
const FLIGHT_PER_TRAVELER = 410;
/** Metro passes, the Sintra return train, and two late-night taxis. */
const TRANSPORT_TOTAL = 96;

function sumBy(predicate: (item: ItineraryItem) => boolean): number {
  return round(
    DAYS.flatMap((day) => day.items)
      .filter(predicate)
      .reduce((sum, item) => sum + item.estimatedCost, 0),
  );
}

const FOOD_TOTAL = sumBy((item) => item.kind === "meal");
const ACTIVITIES_TOTAL = sumBy((item) => item.kind !== "meal");
const FLIGHTS_TOTAL = round(FLIGHT_PER_TRAVELER * REQUEST.travelers);
const ACCOMMODATION_TOTAL = round(NIGHTLY_RATE * NIGHTS);
const GRAND_TOTAL = round(
  FLIGHTS_TOTAL +
    ACCOMMODATION_TOTAL +
    FOOD_TOTAL +
    ACTIVITIES_TOTAL +
    TRANSPORT_TOTAL,
);

/**
 * Totals are summed from the itinerary rather than hand-written, so the budget
 * panel can never disagree with the day cards. Still fully deterministic — the
 * inputs are all literals.
 */
const plan: TripPlan = TripPlanSchema.parse({
  id: MOCK_TRIP_ID,
  schemaVersion: TRIP_PLAN_SCHEMA_VERSION,
  createdAt: "2026-07-25T09:00:00.000Z",
  source: "mock",
  request: REQUEST,
  destination: {
    city: "Lisbon",
    country: "Portugal",
    overview:
      "Lisbon is a city of steep, tiled hills that ends abruptly at a river wide enough to look like the sea. Almost everything you will want to see sits in a two-kilometre band between Alfama in the east and Belém in the west, which makes five days generous rather than tight — the plan below trades breadth for actually sitting down in places.",
    recommendedNeighborhood: {
      name: "Alfama",
      why: "The only district the 1755 earthquake left standing, so the streets still run medieval — narrow, unnumbered and largely car-free. Staying here puts three of your five days within a fifteen-minute walk of the front door, and the tram 28 line does the climbing for you.",
    },
    bestFor: ["history", "architecture", "street-food", "viewpoints"],
    languageNote:
      "Portuguese, with confident English almost everywhere in hospitality. A greeting in Portuguese is noticed and appreciated well out of proportion to the effort.",
    currencyNote:
      "Euro. Cards are near-universal, but the older tascas — including two on this itinerary — still prefer cash, so carry €50 or so.",
    weatherNote:
      "Mid-September averages 26 °C by day and 18 °C at night, with the Atlantic breeze picking up after dark. Rain is unlikely but not impossible; the cobbles get slippery when it does come.",
    center: { lat: 38.7223, lng: -9.1393 },
  },
  flights: {
    isEstimate: true,
    departureCity: "Dubai",
    destinationCity: "Lisbon",
    perTraveler: FLIGHT_PER_TRAVELER,
    total: FLIGHTS_TOTAL,
    cabin: "Economy",
    typicalDuration: "8 hr 45 min – 13 hr",
    typicalStops: "Direct, or one stop via Istanbul, Doha or Madrid",
    searchUrl:
      "https://www.google.com/travel/flights?q=flights%20from%20Dubai%20to%20Lisbon",
    basis:
      "Indicative mid-September return fare from DXB to LIS, booked six to eight weeks out. Not a live quote — check the search link for real prices.",
  },
  accommodation: {
    place: PLACES.hotel,
    style: "boutique",
    neighborhood: "Alfama",
    nightlyRate: NIGHTLY_RATE,
    nights: NIGHTS,
    total: ACCOMMODATION_TOTAL,
    whyItFits:
      "Nineteen rooms in a fifteenth-century palace, which is about as close to your boutique preference as Lisbon gets without moving to the luxury tier. Critically for a hilly city, it sits below Portas do Sol rather than above it, so the walk home from dinner is level rather than a climb.",
    amenities: [
      "Courtyard breakfast",
      "Rooftop plunge pool",
      "Luggage hold on departure day",
      "Two-minute walk to tram 28",
    ],
    isEstimate: true,
  },
  budget: {
    currency: REQUEST.currency,
    requestedBudget: REQUEST.budget,
    flights: FLIGHTS_TOTAL,
    accommodation: ACCOMMODATION_TOTAL,
    food: FOOD_TOTAL,
    activities: ACTIVITIES_TOTAL,
    transport: TRANSPORT_TOTAL,
    total: GRAND_TOTAL,
    remaining: round(REQUEST.budget - GRAND_TOTAL),
    perTraveler: round(GRAND_TOTAL / REQUEST.travelers),
    byDay: DAYS.map((day) => ({
      dayNumber: day.dayNumber,
      amount: day.dayTotal,
    })),
  },
  days: DAYS,
  practicalNotes: [
    "Tram 28 is public transport, not a tourist ride. Board at Martim Moniz before 09:00 or after 19:00 and you will get a seat; in between, walk the same route uphill and take it back down.",
    "Buy a rechargeable Navegante card at any metro station for €0.50 and load it with credit. Single paper tickets cost roughly double per journey.",
    "Pena and Regaleira both sell timed-entry tickets that genuinely sell out in September. Book both the night before at the latest.",
    "Restaurants put bread, olives and cheese on the table unasked — the couvert. It is charged per item; waving it away is normal and costs nothing.",
    "The hills are steeper than the map suggests. Where this plan says walk, it has been checked for gradient; the funiculars and public lifts are covered by your Navegante card.",
    "Alfama's streets are largely unnamed at ground level and phone GPS drifts badly between the buildings. Screenshot the walking directions before you set out for dinner.",
  ],
});

export const mockTripPlan: TripPlan = plan;
export const mockTripRequest: TripRequest = REQUEST;

/**
 * Phase 1 stands in for the generation pipeline: every request returns this same
 * plan, re-keyed to the caller's trip id. The user's own request is preserved
 * on the plan so the workspace can show what was actually asked for, while the
 * itinerary itself stays the fixed Lisbon sample.
 */
export function buildMockPlanForRequest(
  tripId: string,
  request: TripRequest,
  createdAt: string,
): TripPlan {
  return TripPlanSchema.parse({
    ...plan,
    id: tripId,
    createdAt,
    request,
  });
}
