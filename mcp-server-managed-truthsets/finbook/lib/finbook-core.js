// finbook-core.js — Shared computation module for Finbook tools
//
// Pure data layer: no I/O, no CLI, no DOM. Used by:
//   - Browser: data.js, reports.js (via window.FinbookCore)
//   - Node.js: finbook-report.js, validate-finbook.js (via require)
//
// Usage (Node.js):
//   const core = require('./finbook-core');
// Usage (Browser):
//   <script src="js/finbook-core.js"></script>
//   const { dateToFY, COMPUTATIONS } = FinbookCore;

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FinbookCore = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// ---- Constants ----

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const TABLE_NAMES = [
  'AdvanceTax', 'CapitalGainsConsolidated', 'ForeignAccounts',
  'ForeignIncome', 'OtherIncome', 'Properties', 'PropertyIncome',
  'SalaryIncome', 'StockPurchasesOrTransferIns', 'StockSalesOrTransferOuts'
];

const DATE_FIELDS = {
  AdvanceTax: 'EffectiveDate',
  CapitalGainsConsolidated: 'IncomeDate',
  ForeignIncome: 'IncomeDate',
  OtherIncome: 'IncomeDate',
  PropertyIncome: 'IncomeDate',
  SalaryIncome: 'EffectiveDate',
  StockPurchasesOrTransferIns: 'PurchaseDate',
  StockSalesOrTransferOuts: 'SaleDate'
};

const COMPUTED_FIELDS = {
  ForeignIncome: ['ForeignIncomeID', 'IncomeAmountINR', 'TaxesWithheldINR', 'QFY'],
  PropertyIncome: ['PropertyIncomeID', 'NetIncome', 'QFY'],
  CapitalGainsConsolidated: ['CapitalGainsID', 'IncomeAmount', 'QFY', 'CgQ'],
  OtherIncome: ['OtherIncomeID', 'QFY'],
  StockPurchasesOrTransferIns: ['StockPurchaseID', 'TotalPurchaseValue', 'TotalPurchasePricePerUnit', 'TotalPurchaseValueINR', 'QFY'],
  StockSalesOrTransferOuts: ['StockSaleID', 'TotalSaleValue', 'TotalSalePricePerUnit', 'TotalSaleValueINR', 'QFY', 'CgQ'],
  SalaryIncome: ['SalaryIncomeID', 'GrossTaxableIncome', 'NetTaxableIncome', 'QFY'],
  AdvanceTax: ['AdvanceTaxID', 'QFY', 'CgQ']
};

const REQUIRED_FIELDS = {
  SalaryIncome: ['EffectiveDate', 'Employer', 'GrossTaxable'],
  ForeignIncome: ['IncomeDate', 'IncomeSource', 'Currency', 'IncomeAmount', 'ExchangeRateToINR'],
  PropertyIncome: ['IncomeDate', 'PropertyID', 'GrossIncome'],
  CapitalGainsConsolidated: ['IncomeDate', 'IncomeDescription'],
  OtherIncome: ['IncomeDate', 'IncomeDescription', 'IncomeAmount'],
  StockPurchasesOrTransferIns: ['PurchaseDate', 'SecurityName', 'CurrencyCode', 'PurchaseQuantity', 'PurchasePricePerUnit', 'ExchangeRateToINR'],
  StockSalesOrTransferOuts: ['SaleDate', 'SecurityName', 'SaleQuantity', 'SaleAmount', 'ExchangeRateToINR'],
  AdvanceTax: ['EffectiveDate', 'TaxAmountPaid']
};

const NUMBER_FIELDS = {
  SalaryIncome: ['GrossTaxable', 'TaxablePerquisites', 'Exemptions', 'Deductions', 'TDSDeducted'],
  ForeignIncome: ['IncomeAmount', 'TaxesWithheld', 'ExchangeRateToINR'],
  PropertyIncome: ['GrossIncome', 'TotalExpenses', 'TDSDeducted'],
  CapitalGainsConsolidated: ['SaleValue', 'AcquisitionCost', 'Expenses', 'TDSDeducted'],
  OtherIncome: ['IncomeAmount', 'TDSDeducted'],
  StockPurchasesOrTransferIns: ['PurchaseQuantity', 'PurchasePricePerUnit', 'PurchaseExpenses', 'ExchangeRateToINR', 'LotTag'],
  StockSalesOrTransferOuts: ['SaleQuantity', 'SaleAmount', 'SaleExpenses', 'DomesticExpensesINR', 'ExchangeRateToINR'],
  AdvanceTax: ['TaxAmountPaid']
};

const ALLOWED_FIELDS = {
  SalaryIncome: ['EffectiveDate', 'Employer', 'GrossTaxable', 'TaxablePerquisites', 'Exemptions', 'Deductions', 'TDSDeducted', 'Remarks', 'IsLocked', 'SalaryIncomeID', 'GrossTaxableIncome', 'NetTaxableIncome', 'QFY'],
  ForeignIncome: ['IncomeDate', 'IncomeSource', 'IncomeType', 'ForeignAccount', 'Currency', 'IncomeAmount', 'TaxesWithheld', 'ExchangeRateToINR', 'NonTaxable', 'Remarks', 'IsLocked', 'ForeignIncomeID', 'IncomeAmountINR', 'TaxesWithheldINR', 'QFY'],
  PropertyIncome: ['IncomeDate', 'PropertyID', 'GrossIncome', 'TotalExpenses', 'TDSDeducted', 'TDSDeductor', 'Details', 'IsLocked', 'PropertyIncomeID', 'NetIncome', 'QFY'],
  CapitalGainsConsolidated: ['IncomeDate', 'GainsType', 'IncomeDescription', 'SaleValue', 'AcquisitionCost', 'Expenses', 'TDSDeducted', 'TDSDeductor', 'NonTaxable', 'Remarks', 'IsLocked', 'CapitalGainsID', 'IncomeAmount', 'QFY', 'CgQ'],
  OtherIncome: ['IncomeDate', 'IncomeDescription', 'IncomeAmount', 'TDSDeducted', 'TDSDeductor', 'NonTaxable', 'Remarks', 'IsLocked', 'OtherIncomeID', 'QFY'],
  StockPurchasesOrTransferIns: ['PurchaseDate', 'BrokerageName', 'SecurityName', 'CurrencyCode', 'PurchaseQuantity', 'PurchasePricePerUnit', 'PurchaseExpenses', 'ExchangeRateToINR', 'LotTag', 'IsSTTPaid', 'IsTransferIn', 'IsLocked', 'PurchaseLotID', 'StockPurchaseID', 'TotalPurchaseValue', 'TotalPurchasePricePerUnit', 'TotalPurchaseValueINR', 'QFY'],
  StockSalesOrTransferOuts: ['SaleDate', 'SecurityName', 'BrokerageName', 'SaleQuantity', 'SaleAmount', 'SaleExpenses', 'DomesticExpensesINR', 'ExchangeRateToINR', 'PurchaseLots', 'IsTransferOut', 'Remarks', 'IsLocked', 'StockSaleID', 'TotalSaleValue', 'TotalSalePricePerUnit', 'TotalSaleValueINR', 'QFY', 'CgQ'],
  AdvanceTax: ['PaymentDate', 'EffectiveDate', 'TaxAmountPaid', 'PaymentDescription', 'Remarks', 'IsLocked', 'AdvanceTaxID', 'QFY', 'CgQ'],
  ForeignAccounts: ['ForeignAccount', 'Entity', 'AccountNumber'],
  Properties: ['PropertyID', 'PropertyAddress', 'OwnershipSharePercent', 'PropertyType']
};

const UI_ONLY_FIELDS = [];

const DEDUP_KEYS = {
  SalaryIncome: ['EffectiveDate', 'Employer'],
  ForeignIncome: ['IncomeDate', 'IncomeSource', 'Currency', 'IncomeAmount'],
  PropertyIncome: ['IncomeDate', 'PropertyID'],
  CapitalGainsConsolidated: ['IncomeDate', 'IncomeDescription', 'SaleValue'],
  OtherIncome: ['IncomeDate', 'IncomeDescription', 'IncomeAmount'],
  StockPurchasesOrTransferIns: ['PurchaseDate', 'SecurityName', 'PurchaseQuantity', 'PurchasePricePerUnit'],
  StockSalesOrTransferOuts: ['SaleDate', 'SecurityName', 'SaleQuantity'],
  AdvanceTax: ['EffectiveDate', 'TaxAmountPaid']
};

// ---- Date utilities ----

function dateToFY(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const month = d.getMonth();
  const year = d.getFullYear();
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

function dateToQFY(dateStr) {
  if (!dateStr) return null;
  const m = new Date(dateStr).getMonth();
  if (m >= 3 && m <= 5) return 'Q1';
  if (m >= 6 && m <= 8) return 'Q2';
  if (m >= 9 && m <= 11) return 'Q3';
  return 'Q4';
}

function dateToCgQ(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const m = d.getMonth();
  const day = d.getDate();
  if (m === 3 || m === 4 || (m === 5 && day <= 15)) return 'cgQ1';
  if ((m === 5 && day >= 16) || m === 6 || m === 7 || (m === 8 && day <= 15)) return 'cgQ2';
  if ((m === 8 && day >= 16) || m === 9 || m === 10 || (m === 11 && day <= 15)) return 'cgQ3';
  if ((m === 11 && day >= 16) || m === 0 || m === 1 || (m === 2 && day <= 15)) return 'cgQ4';
  return 'cgQ4a';
}

function derivePurchaseLotID(data) {
  const d = data.PurchaseDate ? new Date(data.PurchaseDate) : null;
  if (!d || !data.SecurityName) return '';
  const tag = data.LotTag || 0;
  const day = d.getDate();
  return `${data.SecurityName} - ${data.PurchasePricePerUnit} - ${day}-${MONTHS[d.getMonth()]}-${d.getFullYear()}${tag > 0 ? '-' + tag : ''}`;
}

// ---- Computed field functions ----

const COMPUTATIONS = {
  ForeignIncome: (r, i) => {
    r.ForeignIncomeID = String(i);
    r.IncomeAmountINR = (r.IncomeAmount || 0) * (r.ExchangeRateToINR || 0);
    r.TaxesWithheldINR = (r.TaxesWithheld || 0) * (r.ExchangeRateToINR || 0);
    r.QFY = dateToQFY(r.IncomeDate);
  },
  PropertyIncome: (r, i) => {
    r.PropertyIncomeID = String(i);
    const gross = r.GrossIncome || 0;
    r.NetIncome = gross - (r.TotalExpenses || 0) - (gross * 0.3);
    r.QFY = dateToQFY(r.IncomeDate);
  },
  CapitalGainsConsolidated: (r, i) => {
    r.CapitalGainsID = String(i);
    r.IncomeAmount = (r.SaleValue || 0) - (r.AcquisitionCost || 0) - (r.Expenses || 0);
    r.QFY = dateToQFY(r.IncomeDate);
    r.CgQ = dateToCgQ(r.IncomeDate);
  },
  OtherIncome: (r, i) => {
    r.OtherIncomeID = String(i);
    r.QFY = dateToQFY(r.IncomeDate);
  },
  StockPurchasesOrTransferIns: (r, i) => {
    r.StockPurchaseID = String(i);
    const qty = r.PurchaseQuantity || 0;
    r.TotalPurchaseValue = qty * (r.PurchasePricePerUnit || 0) + (r.PurchaseExpenses || 0);
    r.TotalPurchasePricePerUnit = qty > 0 ? r.TotalPurchaseValue / qty : 0;
    r.TotalPurchaseValueINR = r.TotalPurchaseValue * (r.ExchangeRateToINR || 0);
    r.QFY = dateToQFY(r.PurchaseDate);
  },
  StockSalesOrTransferOuts: (r, i) => {
    r.StockSaleID = String(i);
    const qty = r.SaleQuantity || 0;
    r.TotalSaleValue = (r.SaleAmount || 0) - (r.SaleExpenses || 0);
    r.TotalSalePricePerUnit = qty > 0 ? r.TotalSaleValue / qty : 0;
    r.TotalSaleValueINR = r.TotalSaleValue * (r.ExchangeRateToINR || 0);
    r.QFY = dateToQFY(r.SaleDate);
    r.CgQ = dateToCgQ(r.SaleDate);
  },
  SalaryIncome: (r, i) => {
    r.SalaryIncomeID = String(i);
    const gross = (r.GrossTaxable || 0) + (r.TaxablePerquisites || 0);
    r.GrossTaxableIncome = gross + (r.Exemptions || 0);
    r.NetTaxableIncome = r.GrossTaxableIncome - (r.Deductions || 0);
    r.QFY = dateToQFY(r.EffectiveDate);
  },
  AdvanceTax: (r, i) => {
    r.AdvanceTaxID = String(i);
    r.QFY = dateToQFY(r.EffectiveDate || r.PaymentDate);
    r.CgQ = dateToCgQ(r.EffectiveDate || r.PaymentDate);
  }
};

// ---- Data context ----

function createContext(db, accountCode) {
  if (!db.accounts || !Array.isArray(db.accounts)) {
    throw new Error('Invalid DB: missing accounts array');
  }
  const acct = db.accounts.find(a =>
    a.account.toLowerCase() === accountCode.toLowerCase() ||
    (a.name && a.name.toLowerCase() === accountCode.toLowerCase())
  );
  if (!acct) {
    const available = db.accounts.map(a => a.account).join(', ');
    throw new Error(`Account "${accountCode}" not found. Available: ${available}`);
  }

  function getTable(tableName) {
    const rows = (acct[tableName] || []).filter(r => !r.Deleted);
    const compute = COMPUTATIONS[tableName];
    if (compute) rows.forEach((r, i) => compute(r, i));
    return rows;
  }

  function filterByFY(data, fy, tableName) {
    if (!fy || fy === 'All') return data;
    const dateField = DATE_FIELDS[tableName];
    if (!dateField) return data;
    return data.filter(row => dateToFY(row[dateField]) === fy);
  }

  function getLotMap() {
    const map = {};
    getTable('StockPurchasesOrTransferIns').forEach(p => {
      if (p.PurchaseLotID) map[p.PurchaseLotID] = p;
    });
    return map;
  }

  return { db, acct, getTable, filterByFY, getLotMap };
}

// ---- Report functions ----

function reportIncomeSummary(ctx, fy) {
  const { getTable, filterByFY, getLotMap } = ctx;
  const lotMap = getLotMap();
  const rows = [];

  filterByFY(getTable('ForeignIncome'), fy, 'ForeignIncome').forEach(r => {
    rows.push({ date: r.IncomeDate, category: 'Foreign', description: `${r.IncomeSource || ''} — ${r.IncomeType || ''}`, amount: r.IncomeAmountINR || 0, relief: r.TaxesWithheldINR || 0, tds: 0, quarter: r.QFY || '', currency: r.Currency || '' });
  });
  filterByFY(getTable('PropertyIncome'), fy, 'PropertyIncome').forEach(r => {
    rows.push({ date: r.IncomeDate, category: 'Property', description: r.PropertyID || '', amount: r.GrossIncome || 0, relief: 0, tds: r.TDSDeducted || 0, quarter: r.QFY || '' });
  });
  filterByFY(getTable('CapitalGainsConsolidated'), fy, 'CapitalGainsConsolidated').forEach(r => {
    rows.push({ date: r.IncomeDate, category: 'Capital Gains', description: r.IncomeDescription || '', amount: r.IncomeAmount || 0, relief: 0, tds: r.TDSDeducted || 0, quarter: r.CgQ || '' });
  });
  filterByFY(getTable('StockSalesOrTransferOuts'), fy, 'StockSalesOrTransferOuts').forEach(s => {
    if (s.IsTransferOut) return;
    let acqCostINR = 0;
    (s.PurchaseLots || []).forEach(l => { const p = lotMap[l.PurchaseLotID]; if (p) acqCostINR += (l.SaleQuantity || 0) * (p.TotalPurchasePricePerUnit || 0) * (p.ExchangeRateToINR || 0); });
    rows.push({ date: s.SaleDate, category: 'Capital Gains (Stock)', description: `${s.SecurityName || ''} (${s.SaleQuantity || 0} units)`, amount: (s.TotalSaleValueINR || 0) - acqCostINR - (s.DomesticExpensesINR || 0), relief: 0, tds: 0, quarter: s.CgQ || '' });
  });
  filterByFY(getTable('SalaryIncome'), fy, 'SalaryIncome').forEach(r => {
    rows.push({ date: r.EffectiveDate, category: 'Salary', description: r.Employer || '', amount: r.NetTaxableIncome || 0, relief: 0, tds: r.TDSDeducted || 0, quarter: r.QFY || '' });
  });
  filterByFY(getTable('OtherIncome'), fy, 'OtherIncome').forEach(r => {
    rows.push({ date: r.IncomeDate, category: 'Other', description: r.IncomeDescription || '', amount: r.IncomeAmount || 0, relief: 0, tds: r.TDSDeducted || 0, quarter: r.QFY || '' });
  });
  filterByFY(getTable('AdvanceTax'), fy, 'AdvanceTax').forEach(r => {
    rows.push({ date: r.EffectiveDate || r.PaymentDate, category: 'Advance Tax', description: r.PaymentDescription || '', amount: 0, relief: 0, tds: r.TaxAmountPaid || 0, quarter: r.QFY || '' });
  });

  const byCategory = {};
  rows.forEach(r => {
    if (!byCategory[r.category]) byCategory[r.category] = { income: 0, relief: 0, tds: 0, count: 0 };
    byCategory[r.category].income += r.amount;
    byCategory[r.category].relief += r.relief;
    byCategory[r.category].tds += r.tds;
    byCategory[r.category].count++;
  });
  const totalIncome = Object.entries(byCategory).filter(([k]) => k !== 'Advance Tax').reduce((s, [, v]) => s + v.income, 0);
  const totalRelief = Object.values(byCategory).reduce((s, v) => s + v.relief, 0);
  const totalTDS = Object.values(byCategory).reduce((s, v) => s + v.tds, 0);

  return { rows, byCategory, totalIncome, totalRelief, totalTDS };
}

function reportCapitalGains(ctx, fy) {
  const { getTable, filterByFY, getLotMap } = ctx;
  const lotMap = getLotMap();
  const rows = [];

  filterByFY(getTable('StockSalesOrTransferOuts'), fy, 'StockSalesOrTransferOuts').forEach(s => {
    if (s.IsTransferOut) return;
    const lots = s.PurchaseLots || [];
    let acqCostINR = 0, earliestPurchaseDate = null;
    lots.forEach(l => {
      const p = lotMap[l.PurchaseLotID];
      if (p) {
        acqCostINR += (l.SaleQuantity || 0) * (p.TotalPurchasePricePerUnit || 0) * (p.ExchangeRateToINR || 0);
        const pd = p.PurchaseDate ? new Date(p.PurchaseDate) : null;
        if (pd && (!earliestPurchaseDate || pd < earliestPurchaseDate)) earliestPurchaseDate = pd;
      }
    });
    const saleDate = s.SaleDate ? new Date(s.SaleDate) : null;
    const holdingDays = (saleDate && earliestPurchaseDate) ? Math.floor((saleDate - earliestPurchaseDate) / 86400000) : null;
    const holdingType = holdingDays != null ? (holdingDays > 365 ? 'LTCG' : 'STCG') : null;
    const saleValueINR = s.TotalSaleValueINR || 0;
    const expINR = s.DomesticExpensesINR || 0;
    rows.push({ date: s.SaleDate, source: 'Stock', security: s.SecurityName || '', brokerage: s.BrokerageName || '', quantity: s.SaleQuantity || 0, holdingType, holdingDays, saleValue: saleValueINR, acquisitionCost: acqCostINR, expenses: expINR, gainLoss: saleValueINR - acqCostINR - expINR, quarter: s.CgQ || '', taxable: true });
  });

  filterByFY(getTable('CapitalGainsConsolidated'), fy, 'CapitalGainsConsolidated').forEach(r => {
    rows.push({ date: r.IncomeDate, source: 'Manual', description: r.IncomeDescription || '', holdingType: r.GainsType || null, holdingDays: null, saleValue: r.SaleValue || 0, acquisitionCost: r.AcquisitionCost || 0, expenses: r.Expenses || 0, gainLoss: r.IncomeAmount || 0, tds: r.TDSDeducted || 0, quarter: r.CgQ || '', taxable: !r.NonTaxable });
  });

  const totalGainLoss = rows.reduce((s, r) => s + r.gainLoss, 0);
  const ltcg = rows.filter(r => r.holdingType === 'LTCG').reduce((s, r) => s + r.gainLoss, 0);
  const stcg = rows.filter(r => r.holdingType === 'STCG').reduce((s, r) => s + r.gainLoss, 0);

  return { rows, totalGainLoss, ltcg, stcg };
}

function reportStockTransactions(ctx, fy) {
  const { getTable, filterByFY } = ctx;
  const txns = [];

  filterByFY(getTable('StockPurchasesOrTransferIns'), fy, 'StockPurchasesOrTransferIns').forEach(p => {
    txns.push({
      date: p.PurchaseDate,
      type: p.IsTransferIn ? 'Transfer In' : 'Buy',
      security: p.SecurityName || '',
      brokerage: p.BrokerageName || '',
      quantity: p.PurchaseQuantity || 0,
      pricePerUnit: p.PurchasePricePerUnit || 0,
      currency: p.CurrencyCode || '',
      totalValue: p.TotalPurchaseValue || 0,
      exchangeRate: p.ExchangeRateToINR || 0,
      valueINR: p.TotalPurchaseValueINR || 0,
      lotId: p.PurchaseLotID || ''
    });
  });

  filterByFY(getTable('StockSalesOrTransferOuts'), fy, 'StockSalesOrTransferOuts').forEach(s => {
    txns.push({
      date: s.SaleDate,
      type: s.IsTransferOut ? 'Transfer Out' : 'Sell',
      security: s.SecurityName || '',
      brokerage: s.BrokerageName || '',
      quantity: s.SaleQuantity || 0,
      saleAmount: s.SaleAmount || 0,
      totalValue: s.TotalSaleValue || 0,
      exchangeRate: s.ExchangeRateToINR || 0,
      valueINR: s.TotalSaleValueINR || 0,
      purchaseLots: s.PurchaseLots || []
    });
  });

  txns.sort((a, b) => {
    const dc = (a.date || '').localeCompare(b.date || '');
    if (dc !== 0) return dc;
    return (a.type === 'Buy' || a.type === 'Transfer In') ? -1 : 1;
  });

  return { transactions: txns, count: txns.length };
}

function reportHoldings(ctx, asOnDate) {
  const { getTable } = ctx;
  const purchases = getTable('StockPurchasesOrTransferIns');
  const sales = getTable('StockSalesOrTransferOuts');
  const asOn = new Date(asOnDate + 'T23:59:59');

  const soldPerLot = {};
  sales.forEach(s => {
    if (new Date(s.SaleDate) > asOn) return;
    (s.PurchaseLots || []).forEach(l => {
      soldPerLot[l.PurchaseLotID] = (soldPerLot[l.PurchaseLotID] || 0) + (l.SaleQuantity || 0);
    });
  });

  const holdings = {};
  purchases.forEach(p => {
    if (new Date(p.PurchaseDate) > asOn) return;
    const sec = p.SecurityName || '';
    if (!holdings[sec]) holdings[sec] = { quantity: 0, totalCost: 0, totalCostINR: 0, currency: p.CurrencyCode || '', lots: [] };
    const sold = soldPerLot[p.PurchaseLotID] || 0;
    const remaining = Math.max(0, (p.PurchaseQuantity || 0) - sold);
    if (remaining < 0.0005) return;
    const costRatio = (p.PurchaseQuantity || 0) > 0 ? remaining / p.PurchaseQuantity : 0;
    const cost = (p.TotalPurchaseValue || 0) * costRatio;
    const costINR = (p.TotalPurchaseValueINR || 0) * costRatio;
    holdings[sec].quantity += remaining;
    holdings[sec].totalCost += cost;
    holdings[sec].totalCostINR += costINR;
    if (!holdings[sec].currency && p.CurrencyCode) holdings[sec].currency = p.CurrencyCode;
    holdings[sec].lots.push({
      lotId: p.PurchaseLotID, purchaseDate: p.PurchaseDate, brokerage: p.BrokerageName || '',
      remaining, pricePerUnit: p.PurchasePricePerUnit || 0, currency: p.CurrencyCode || '', cost, costINR
    });
  });

  const list = Object.entries(holdings)
    .filter(([, v]) => v.quantity > 0.0005)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sec, v]) => ({
      security: sec, quantity: v.quantity,
      avgCost: v.quantity > 0 ? v.totalCost / v.quantity : 0,
      avgCostINR: v.quantity > 0 ? v.totalCostINR / v.quantity : 0,
      totalCost: v.totalCost,
      totalCostINR: v.totalCostINR,
      currency: v.currency || '',
      lots: v.lots
    }));

  const totalPortfolioValue = list.reduce((s, h) => s + h.totalCostINR, 0);
  return { asOnDate, holdings: list, totalPortfolioValue };
}

function reportStockPurchases(ctx, fy) {
  const { getTable, filterByFY } = ctx;
  const rows = filterByFY(getTable('StockPurchasesOrTransferIns'), fy, 'StockPurchasesOrTransferIns');
  return { rows: rows.map(r => ({ ...r })), count: rows.length };
}

function reportStockSales(ctx, fy) {
  const { getTable, filterByFY } = ctx;
  const rows = filterByFY(getTable('StockSalesOrTransferOuts'), fy, 'StockSalesOrTransferOuts');
  return { rows: rows.map(r => ({ ...r })), count: rows.length };
}

// ---- Public API ----

return {
  // Constants
  TABLE_NAMES, DATE_FIELDS, COMPUTED_FIELDS, REQUIRED_FIELDS, NUMBER_FIELDS, ALLOWED_FIELDS, UI_ONLY_FIELDS, DEDUP_KEYS, MONTHS,
  // Date utilities
  dateToFY, dateToQFY, dateToCgQ, derivePurchaseLotID,
  // Computation
  COMPUTATIONS,
  // Context
  createContext,
  // Reports
  reports: {
    incomeSummary: reportIncomeSummary,
    capitalGains: reportCapitalGains,
    stockTransactions: reportStockTransactions,
    holdings: reportHoldings,
    stockPurchases: reportStockPurchases,
    stockSales: reportStockSales
  }
};

}));