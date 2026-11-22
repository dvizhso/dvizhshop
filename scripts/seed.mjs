// Первичное наполнение базы DVIZH FREIBURG.
// Идемпотентно: если товары уже есть — ничего не меняет.
// Запуск: npm run seed
import { loadEnv, log } from '../lib/core.mjs';
import {
  getDb, getSetting, setSetting, listCollections, createCollection,
  listProducts, createProduct, listBanners, createBanner, getDbPath,
} from '../lib/db.mjs';

loadEnv();

const COLLECTION = 'Первая коллекция';

const PRODUCTS = [
  {
    name: 'Футболка DVIZH',
    description: 'Базовая футболка с логотипом DVIZH FREIBURG. Плотный хлопок 240 г/м², свободный крой.',
    price_cents: 2500,
    sizes: 'XS,S,M,L,XL,XXL',
    colors: 'Чёрный,Белый',
    stock: 12,
  },
  {
    name: 'Худи DVIZH',
    description: 'Плотное худи для повседневной носки. Утеплённый футер, свободный крой, вышивка DVIZH.',
    price_cents: 5500,
    sizes: 'S,M,L,XL,XXL',
    colors: 'Чёрный,Серый',
    stock: 8,
  },
  {
    name: 'Зип-худи DVIZH',
    description: 'Худи на молнии с высоким воротом. Карманы-кенгуру, фирменная нашивка на груди.',
    price_cents: 6000,
    sizes: 'S,M,L,XL,XXL',
    colors: 'Чёрный',
    stock: 6,
  },
  {
    name: 'Свитшот DVIZH',
    description: 'Минималистичный свитшот с логотипом. Мягкий футер, универсальная посадка.',
    price_cents: 4500,
    sizes: 'S,M,L,XL',
    colors: 'Чёрный,Белый',
    stock: 10,
  },
  {
    name: 'Лонгслив DVIZH',
    description: 'Футболка с длинным рукавом. Тонкий плотный трикотаж, принт на груди и рукаве.',
    price_cents: 3200,
    sizes: 'S,M,L,XL',
    colors: 'Чёрный',
    stock: 9,
  },
  {
    name: 'Кепка DVIZH',
    description: 'Кепка с вышивкой DVIZH. Регулируемый ремешок, изогнутый козырёк.',
    price_cents: 2000,
    sizes: 'ONE SIZE',
    colors: 'Чёрный',
    stock: 15,
  },
];

function main() {
  const db = getDb();
  log('seed', `база: ${getDbPath()}`);

  if (listProducts().length > 0) {
    log('seed', 'товары уже есть — наполнение пропущено (ничего не перезаписано)');
    return;
  }

  let collection = listCollections().find((c) => c.name === COLLECTION)
    || listCollections()[0]
    || createCollection({ name: COLLECTION, description: 'Базовый дроп DVIZH FREIBURG.' });

  for (const item of PRODUCTS) {
    const product = createProduct({ ...item, collection_id: collection.id, active: true });
    log('seed', `+ ${product.name} — ${(product.price_cents / 100).toFixed(2)} €, склад ${product.stock}`);
  }

  if (listBanners().length === 0) {
    const banner = createBanner({
      title: 'COMMUNITY GOODS',
      subtitle: 'Официальный мерч DVIZH FREIBURG. Ограниченные серии — пока есть на складе.',
      link: '',
      active: true,
      sort: 1,
    });
    log('seed', `+ баннер «${banner.title}»`);
  }

  if (!getSetting('admin_id')) {
    setSetting('admin_id', '');
  }

  log('seed', `готово: ${listProducts().length} товаров, ${listCollections().length} коллекций`);
  log('seed', 'теперь запустите сервер: npm start (и бота отдельно: npm run bot)');
}

try {
  main();
} catch (e) {
  log('seed', `ОШИБКА: ${e.message}`);
  process.exitCode = 1;
}
