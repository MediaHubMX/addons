// Display names, taken from the v1 addon's locales,
// plus the departments below, which TMDB only ever hands out in English.
// English is the fallback for every key a language does not have.

export const STRINGS = {
  "de": {
    "description": "Film- und Serieninfos von The Movie Database.",
    "movies": "Filme",
    "series": "Serien",
    "genre": "Genre",
    "year": "Jahr",
    "popularity": "Popularität",
    "releaseDate": "Veröffentlichungsdatum",
    "trendingDay": "Angesagt heute",
    "trendingWeek": "Angesagt diese Woche",
    "popularMovies": "Beliebte Filme",
    "trendingMovies": "Angesagte Filme",
    "popularSeries": "Beliebte Serien",
    "trendingSeries": "Angesagte Serien",
    "recommended": "Empfohlen",
    "similar": "Ähnlich"
  },
  "en": {
    "description": "Movie and series infos provided by The Movie Database.",
    "movies": "Movies",
    "series": "Series",
    "people": "People",
    "genre": "Genre",
    "year": "Year",
    "origLang": "Original Language",
    "popularity": "Popularity",
    "releaseDate": "Release date",
    "trendingDay": "Trending today",
    "trendingWeek": "Trending this week",
    "popularMovies": "Popular Movies",
    "trendingMovies": "Trending Movies",
    "popularSeries": "Popular Series",
    "trendingSeries": "Trending Series",
    "recommended": "Recommended",
    "similar": "Similar"
  },
  "es": {
    "description": "Información sobre películas y series proporcionada por The Movie Database.",
    "movies": "Películas",
    "series": "Serie",
    "genre": "Género",
    "year": "Año",
    "popularity": "Popularidad",
    "releaseDate": "Fecha de lanzamiento",
    "trendingDay": "Tendencia hoy",
    "trendingWeek": "Tendencia esta semana",
    "popularMovies": "Películas populares",
    "trendingMovies": "Películas de tendencia",
    "popularSeries": "Series populares",
    "trendingSeries": "Angesagte Serien",
    "recommended": "Recomendado",
    "similar": "Similar"
  },
  "fr": {
    "description": "Informations sur les films et les séries fournies par The Movie Database.",
    "movies": "Films",
    "series": "Séries",
    "genre": "Genre",
    "year": "Année",
    "popularity": "Popularité",
    "releaseDate": "Date de sortie",
    "trendingDay": "Tendance aujourd'hui",
    "trendingWeek": "Tendance cette semaine",
    "popularMovies": "Films populaires",
    "trendingMovies": "Films tendances",
    "popularSeries": "Séries populaires",
    "trendingSeries": "Séries tendances",
    "recommended": "Conseillé",
    "similar": "Similaire"
  },
  "nl": {
    "description": "Informatie over films en series geleverd door The Movie Database.",
    "movies": "Films",
    "series": "Series",
    "genre": "Genre",
    "year": "Jaar",
    "popularity": "Populariteit",
    "releaseDate": "Release datum",
    "trendingDay": "Trending vandaag",
    "trendingWeek": "Trending deze week",
    "popularMovies": "Populaire films",
    "trendingMovies": "Trending films",
    "popularSeries": "Populaire series",
    "trendingSeries": "Trending series",
    "recommended": "Aanbevolen",
    "similar": "Vergelijkbaar"
  },
  "tr": {
    "description": "The Movie Database tarafından sağlanan film ve dizi bilgileri.",
    "movies": "Filmler",
    "series": "Diziler",
    "genre": "Tür",
    "year": "Yıl",
    "popularity": "Popülerlik",
    "releaseDate": "Yayın tarihi",
    "trendingDay": "Bugün trend",
    "trendingWeek": "Bu hafta popüler",
    "popularMovies": "Popüler Filmler",
    "trendingMovies": "Trend Olan Filmler",
    "popularSeries": "Popüler Diziler",
    "trendingSeries": "Trend Olan Diziler",
    "recommended": "Önerilen",
    "similar": "Benzer"
  }
};

// TMDB names a person's department in English whatever language is asked for,
// and it lands unchanged in the facts line under their name. The list is
// closed: these twelve are all TMDB uses.
export const DEPARTMENTS = {
  de: {
    Acting: "Schauspiel", Art: "Szenenbild", Camera: "Kamera",
    "Costume & Make-Up": "Kostüm & Maske", Crew: "Crew", Directing: "Regie",
    Editing: "Schnitt", Lighting: "Licht", Production: "Produktion",
    Sound: "Ton", "Visual Effects": "Visuelle Effekte", Writing: "Drehbuch",
  },
  fr: {
    Acting: "Interprétation", Art: "Décors", Camera: "Caméra",
    "Costume & Make-Up": "Costumes et maquillage", Crew: "Équipe technique",
    Directing: "Réalisation", Editing: "Montage", Lighting: "Éclairage",
    Production: "Production", Sound: "Son", "Visual Effects": "Effets visuels",
    Writing: "Scénario",
  },
  es: {
    Acting: "Interpretación", Art: "Arte", Camera: "Cámara",
    "Costume & Make-Up": "Vestuario y maquillaje", Crew: "Equipo técnico",
    Directing: "Dirección", Editing: "Montaje", Lighting: "Iluminación",
    Production: "Producción", Sound: "Sonido", "Visual Effects": "Efectos visuales",
    Writing: "Guion",
  },
  nl: {
    Acting: "Acteren", Art: "Decor", Camera: "Camera",
    "Costume & Make-Up": "Kostuums en make-up", Crew: "Crew", Directing: "Regie",
    Editing: "Montage", Lighting: "Belichting", Production: "Productie",
    Sound: "Geluid", "Visual Effects": "Visuele effecten", Writing: "Scenario",
  },
  tr: {
    Acting: "Oyunculuk", Art: "Sanat", Camera: "Kamera",
    "Costume & Make-Up": "Kostüm ve Makyaj", Crew: "Ekip", Directing: "Yönetmenlik",
    Editing: "Kurgu", Lighting: "Işık", Production: "Yapım", Sound: "Ses",
    "Visual Effects": "Görsel Efektler", Writing: "Senaryo",
  },
};

/** A department in the given language, or as TMDB wrote it. */
export function department(value, language) {
  if (!value) return null;
  const lang = String(language || "en").split("-")[0].toLowerCase();
  return DEPARTMENTS[lang]?.[value] || value;
}

export function translator(language) {
  const lang = String(language || "en").split("-")[0].toLowerCase();
  const table = STRINGS[lang] || {};
  return (key) => table[key] || STRINGS.en[key] || key;
}
