// The fixed cuisine list. Shared by the entry form, admin page (browser) and the server (require).
(function (list) {
  if (typeof module !== "undefined") module.exports = list;
  else window.CUISINES = list;
})([
  "American", "Asian Fusion", "Boba", "Brazilian", "Brunch", "Cafe", "Caribbean", "Chinese",
  "Dessert", "Fine Dine", "Indian", "Indonesian", "Italian", "Japanese", "Korean", "Malaysian",
  "Mediterranean", "Mexican", "Russian", "Taiwanese", "Thai", "Vietnamese",
]);
