module.exports = async function handler(req, res) {
  const token = process.env.PRINTIFY_API_TOKEN;
  const r = await fetch('https://api.printify.com/v1/shops/21428039/products/6a3fd211e7b8a9601e0f64cd.json', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await r.json();
  const colors = ['Grey','Ivory','Bay','Seafoam','Chambray','Blue Spruce','Blue Jean','True Navy','Orchid','Berry','Violet','Blossom'];
  const result = {};
  colors.forEach(color => {
    result[color] = data.variants.filter(v => v.title && v.title.startsWith(color)).map(v => ({ id: v.id, title: v.title, enabled: v.is_enabled }));
  });
  res.json(result);
};
