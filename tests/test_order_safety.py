import logging
import unittest
from decimal import Decimal
from unittest.mock import patch

from auto_sell_orders import AutoSellOrders
from cancel_pending_limits import OKXLimitOrderManager
from cancel_pending_triggers import OKXOrderManager
from create_algo_triggers import OKXAlgoTrigger
from fetch_filled_orders import OKXFilledOrdersFetcher
from okx_client import OKXClient, get_order_operation_error
from monitor_delist import OKXDelistMonitor
from protection_manager import ProtectionManager


class _TradeAPI:
    def __init__(self, place_result, order_result=None):
        self.place_result = place_result
        self.order_result = order_result
        self.last_get_order_kwargs = None
        self.last_place_order_kwargs = None

    def place_order(self, **kwargs):
        self.last_place_order_kwargs = kwargs
        return self.place_result

    def get_order(self, **kwargs):
        self.last_get_order_kwargs = kwargs
        return self.order_result

    def cancel_algo_order(self, _orders):
        return self.place_result

    def get_fills(self, **_kwargs):
        return self.place_result


class _AccountAPI:
    def __init__(self, result):
        self.result = result

    def get_account_balance(self):
        return self.result


class _OKXClientWithAccount:
    def __init__(self, account_api):
        self.account_api = account_api

    def get_account_api(self):
        return self.account_api


class _BalanceAPI:
    def __init__(self, result):
        self.result = result

    def get_account_balance(self, **_kwargs):
        return self.result


class _Cursor:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []
        self.rowcount = 1

    def execute(self, statement, params=None):
        self.executed.append((statement, params))

    def fetchall(self):
        return self.rows


class _Connection:
    def commit(self):
        pass


class OrderSafetyTests(unittest.TestCase):
    def test_operation_error_rejects_per_order_failure_and_empty_mutation_data(self):
        self.assertIsNotNone(get_order_operation_error({'code': '0', 'data': [{'sCode': '51000', 'sMsg': 'bad'}]}))
        self.assertIsNotNone(get_order_operation_error({'code': '0', 'data': []}, require_data=True))

    def test_trigger_cancel_rejects_per_order_failure(self):
        fetcher = OKXFilledOrdersFetcher.__new__(OKXFilledOrdersFetcher)
        fetcher.trade_api = _TradeAPI({'code': '0', 'data': [{'sCode': '51000', 'sMsg': 'bad'}]})
        self.assertFalse(fetcher.cancel_algo_orders_batch([{'instId': 'BTC-USDT', 'algoId': '1'}]))

    def test_market_sell_only_succeeds_after_filled_confirmation(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.min_usd_value = 1
        seller.trade_api = _TradeAPI(
            {'code': '0', 'data': [{'sCode': '0', 'ordId': '123'}]},
            {'code': '0', 'data': [{'state': 'filled'}]},
        )
        seller.get_available_balance = lambda _inst_id: (1, 10, 10, False, True)
        self.assertEqual(
            seller.place_market_sell_order('BTC-USDT', '1', 'sell-test'),
            ('FILLED', '123'),
        )

    def test_market_sell_rounds_down_to_exchange_lot_size(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.min_usd_value = 0.01
        seller.instrument_rules_cache = {
            'BTC-USDT': {'lot_sz': Decimal('0.01'), 'min_sz': Decimal('0.01')},
        }
        seller.okx_client = object()
        seller.trade_api = _TradeAPI(
            {'code': '0', 'data': [{'sCode': '0', 'ordId': '123'}]},
            {'code': '0', 'data': [{'state': 'filled'}]},
        )
        seller.get_available_balance = lambda _inst_id: (1, 100, 100, False, True)

        self.assertEqual(
            seller.place_market_sell_order('BTC-USDT', '0.019', 'sell-test'),
            ('FILLED', '123'),
        )
        self.assertEqual(seller.trade_api.last_place_order_kwargs['sz'], '0.01')

    def test_unconfirmed_sell_is_retained_for_verification(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.trade_api = _TradeAPI(None, {'code': '0', 'data': [{'state': 'live'}]})
        self.assertEqual(seller.get_market_sell_state('BTC-USDT', '123'), 'PENDING')

    def test_interrupted_sell_can_be_recovered_by_stable_client_order_id(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        trade_api = _TradeAPI(None, {'code': '0', 'data': [{'state': 'filled'}]})
        seller.trade_api = trade_api
        client_order_id = seller._sell_client_order_id('trade-1')
        self.assertEqual(
            seller.get_market_sell_state('BTC-USDT', client_order_id=client_order_id),
            'FILLED',
        )
        self.assertEqual(trade_api.last_get_order_kwargs['clOrdId'], client_order_id)
        self.assertEqual(trade_api.last_get_order_kwargs['ordId'], '')

    def test_missing_interrupted_order_is_safe_to_unlock(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.trade_api = _TradeAPI(None, {'code': '51603', 'msg': 'Order does not exist', 'data': []})
        self.assertEqual(
            seller.get_market_sell_state('BTC-USDT', client_order_id='sell-test'),
            'NOT_FOUND',
        )

    def test_submitted_sell_is_reconciled_even_when_balance_gate_is_empty(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.has_significant_non_usdt_assets = lambda: False
        seller.ensure_database_initialized = lambda: None
        seller.normalize_pending_sell_times = lambda: self.fail('must not normalize new orders without balance')
        seller.get_orders_ready_to_sell = lambda: [
            ('BTC-USDT', 'buy-1', 'trade-1', '1', 'buy', '1', '1', '1', 'SELL_SUBMITTED', 'sell-1')
        ]
        seller.get_market_sell_state = lambda *_args, **_kwargs: 'FILLED'
        marked = []
        seller.mark_trades_as_sold_batch = lambda trade_ids: marked.extend(trade_ids) or len(trade_ids)
        seller.mark_trigger_rebuild_pending = lambda _trade_ids: True
        seller.has_pending_trigger_rebuild = lambda: True
        seller.clear_pending_trigger_rebuild = lambda: True
        seller.rebuild_triggers_after_market_sell = lambda: True
        seller.process_sell_orders()
        self.assertEqual(marked, ['trade-1'])

    def test_trigger_rebuild_failure_after_filled_sell_propagates(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.has_significant_non_usdt_assets = lambda: False
        seller.ensure_database_initialized = lambda: None
        seller.get_orders_ready_to_sell = lambda: [
            ('BTC-USDT', 'buy-1', 'trade-1', '1', 'buy', '1', '1', '1', 'SELL_SUBMITTED', 'sell-1')
        ]
        seller.get_market_sell_state = lambda *_args, **_kwargs: 'FILLED'
        seller.mark_trades_as_sold_batch = lambda trade_ids: len(trade_ids)
        seller.mark_trigger_rebuild_pending = lambda _trade_ids: True
        seller.has_pending_trigger_rebuild = lambda: True
        seller.rebuild_triggers_after_market_sell = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'Pending trigger rebuild'):
            seller.process_sell_orders()

    def test_pending_trigger_rebuild_retries_without_due_sell_orders(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.has_significant_non_usdt_assets = lambda: False
        seller.ensure_database_initialized = lambda: None
        seller.get_orders_ready_to_sell = lambda: []
        seller.has_pending_trigger_rebuild = lambda: True
        seller.rebuild_triggers_after_market_sell = lambda: True
        cleared = []
        seller.clear_pending_trigger_rebuild = lambda: cleared.append(True) or True
        seller.process_sell_orders()
        self.assertEqual(cleared, [True])

    def test_protection_is_failed_when_cancellation_or_sell_is_incomplete(self):
        manager = ProtectionManager()
        manager.execute_cancellation_scripts = lambda **_kwargs: False
        manager.handle_affected_balances = lambda _cryptos: (1, 1)
        self.assertEqual(manager.execute_full_protection({'BTC'})['status'], 'failed')

        manager.execute_cancellation_scripts = lambda **_kwargs: True
        manager.handle_affected_balances = lambda _cryptos: (0, 1)
        self.assertEqual(manager.execute_full_protection({'BTC'})['status'], 'failed')

    def test_affected_balance_query_fails_closed_on_api_error_or_frozen_balance(self):
        client = OKXClient.__new__(OKXClient)
        client.logger = logging.getLogger('test-okx-client')

        client.account_api = _AccountAPI({'code': '50000', 'msg': 'temporary error'})
        with self.assertRaises(RuntimeError):
            client.get_affected_balances({'BTC'})

        client.account_api = _AccountAPI({
            'code': '0',
            'data': [{'details': [{'ccy': 'BTC', 'cashBal': '1', 'availBal': '0', 'eq': '1'}]}],
        })
        with self.assertRaises(RuntimeError):
            client.get_affected_balances({'BTC'})

    def test_trigger_protection_failure_propagates(self):
        fetcher = OKXFilledOrdersFetcher.__new__(OKXFilledOrdersFetcher)
        fetcher.auto_mark_manual_sells = lambda: 0
        fetcher.count_active_trading_currencies = lambda: 3
        fetcher.cancel_all_trigger_orders = lambda: (_ for _ in ()).throw(RuntimeError('cancel failed'))
        with self.assertRaisesRegex(RuntimeError, 'cancel failed'):
            fetcher.check_and_cancel_triggers_if_needed()

    def test_account_only_trigger_protection_fails_closed(self):
        fetcher = OKXFilledOrdersFetcher.__new__(OKXFilledOrdersFetcher)
        fetcher.okx_client = _OKXClientWithAccount(_AccountAPI({'code': '50000', 'msg': 'temporary error'}))
        with self.assertRaises(RuntimeError):
            fetcher.check_and_cancel_triggers_by_account_balance()

        fetcher.okx_client = _OKXClientWithAccount(_AccountAPI({
            'code': '0',
            'data': [{'details': [
                {'ccy': 'BTC', 'eqUsd': '10'},
                {'ccy': 'ETH', 'eqUsd': '10'},
                {'ccy': 'SOL', 'eqUsd': '10'},
            ]}],
        }))
        fetcher.cancel_all_trigger_orders = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'Failed to cancel'):
            fetcher.check_and_cancel_triggers_by_account_balance()

    def test_filled_trade_api_error_is_not_treated_as_no_trades(self):
        fetcher = OKXFilledOrdersFetcher.__new__(OKXFilledOrdersFetcher)
        fetcher.trade_api = _TradeAPI({'code': '50000', 'msg': 'temporary error'})
        with self.assertRaisesRegex(RuntimeError, 'filled-trades API error'):
            fetcher.get_filled_trades.__wrapped__(fetcher)

    def test_delist_api_error_is_not_treated_as_no_announcements(self):
        monitor = OKXDelistMonitor.__new__(OKXDelistMonitor)
        monitor.base_url = 'https://example.invalid'
        monitor.logger = logging.getLogger('test-monitor-delist')
        monitor.generate_signature = lambda *_args: 'signature'
        monitor.get_headers = lambda *_args: {}

        class _Response:
            status_code = 200

            @staticmethod
            def json():
                return {'code': '50000', 'msg': 'temporary error'}

        with patch('monitor_delist.get_global_session'), patch('monitor_delist.safe_request', return_value=_Response()), patch('monitor_delist.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'Unable to fetch OKX delist announcements'):
                monitor.fetch_delist_announcements()

    def test_pending_order_query_errors_are_not_treated_as_empty(self):
        limit_manager = OKXLimitOrderManager.__new__(OKXLimitOrderManager)
        limit_manager.trade_api = type('TradeAPI', (), {
            'get_order_list': lambda *_args, **_kwargs: {'code': '50000', 'msg': 'temporary error'},
        })()
        with self.assertRaisesRegex(RuntimeError, 'pending limit-orders API error'):
            limit_manager.get_pending_limit_orders.__wrapped__(limit_manager)

        trigger_manager = OKXOrderManager.__new__(OKXOrderManager)
        trigger_manager.trade_api = type('TradeAPI', (), {
            'order_algos_list': lambda *_args, **_kwargs: {'code': '50000', 'msg': 'temporary error'},
        })()
        with self.assertRaisesRegex(RuntimeError, 'pending trigger-orders API error'):
            trigger_manager.get_pending_algo_orders.__wrapped__(trigger_manager)

    def test_expected_strategy_skips_do_not_fail_trigger_run(self):
        self.assertTrue(OKXAlgoTrigger._is_expected_skip_reason("Blacklisted: delisted"))
        self.assertTrue(OKXAlgoTrigger._is_expected_skip_reason("Skipped due to yesterday gain above 10%"))
        self.assertFalse(OKXAlgoTrigger._is_expected_skip_reason("Failed to create order"))

    def test_trigger_creation_stops_when_blacklist_cannot_be_verified(self):
        trigger_creator = OKXAlgoTrigger.__new__(OKXAlgoTrigger)
        trigger_creator.blacklist_manager = type('Blacklist', (), {
            'get_blacklisted_cryptos': lambda _self: None,
        })()
        trigger_creator._get_significant_non_usdt_assets = lambda: []

        class _ConfigManager:
            def __init__(self, *_args, **_kwargs):
                pass

            def load_full_config(self):
                return {'crypto_configs': {'BTC-USDT': {'best_limit': '90'}}}

        with patch('config_manager.ConfigManager', _ConfigManager):
            self.assertFalse(trigger_creator.process_limits_from_database())

    def test_auto_sell_uses_configured_threshold_instead_of_fixed_one_dollar_gate(self):
        seller = AutoSellOrders.__new__(AutoSellOrders)
        seller.logger = logging.getLogger('test-auto-sell')
        seller.min_usd_value = 0.01
        seller.okx_client = _OKXClientWithAccount(_BalanceAPI({
            'code': '0',
            'data': [{'details': [{'ccy': 'BTC', 'eqUsd': '0.50'}]}],
        }))
        self.assertTrue(seller.has_significant_non_usdt_assets())

    def test_manual_sell_reconciliation_does_not_mark_frozen_or_non_dust_balance_sold(self):
        fetcher = OKXFilledOrdersFetcher.__new__(OKXFilledOrdersFetcher)
        fetcher.ensure_database_initialized = lambda: None
        fetcher.cursor = _Cursor([('BTC-USDT',)])
        fetcher.conn = _Connection()
        fetcher.okx_client = _OKXClientWithAccount(_BalanceAPI({
            'code': '0',
            'data': [{'details': [{
                'ccy': 'BTC', 'eqUsd': '0.50', 'frozenBal': '0.1', 'ordFrozen': '0',
            }]}],
        }))

        with patch('fetch_filled_orders.time.sleep'):
            fetcher.auto_mark_manual_sells()

        updates = [statement for statement, _params in fetcher.cursor.executed if 'SET sold_status' in statement]
        self.assertEqual(updates, [])

    def test_manual_sell_reconciliation_marks_only_unsubmitted_dust_lots(self):
        fetcher = OKXFilledOrdersFetcher.__new__(OKXFilledOrdersFetcher)
        fetcher.ensure_database_initialized = lambda: None
        fetcher.cursor = _Cursor([('BTC-USDT',)])
        fetcher.conn = _Connection()
        fetcher.okx_client = _OKXClientWithAccount(_BalanceAPI({
            'code': '0',
            'data': [{'details': [{'ccy': 'BTC', 'eqUsd': '0.001', 'frozenBal': '0', 'ordFrozen': '0'}]}],
        }))

        with patch('fetch_filled_orders.time.sleep'):
            fetcher.auto_mark_manual_sells()

        updates = [statement for statement, _params in fetcher.cursor.executed if 'SET sold_status' in statement]
        self.assertEqual(len(updates), 1)
        self.assertIn('AND sold_status IS NULL', updates[0])

    def test_trigger_cancellation_uses_final_exchange_state_not_transient_batch_errors(self):
        manager = OKXOrderManager.__new__(OKXOrderManager)
        order = {'instId': 'BTC-USDT', 'algoId': '1', 'ordType': 'trigger'}
        pending_responses = [[order], []]
        manager.get_pending_algo_orders = lambda: pending_responses.pop(0)
        manager.cancel_algo_orders_batch = lambda _orders: False

        with patch('cancel_pending_triggers.time.sleep'):
            self.assertTrue(manager.cancel_all_pending_triggers())

    def test_yesterday_gain_filter_uses_strict_ten_percent_threshold(self):
        class _MarketAPI:
            def __init__(self, candles):
                self.candles = candles
                self.calls = []

            def get_candlesticks(self, **kwargs):
                self.calls.append(kwargs)
                return {'code': '0', 'data': self.candles}

        trigger_creator = OKXAlgoTrigger.__new__(OKXAlgoTrigger)
        trigger_creator.data_cache = {}
        trigger_creator.market_api = _MarketAPI([
            ['today', '100', '100', '100', '100'],
            ['yesterday', '100', '111', '99', '110.01'],
        ])
        self.assertTrue(trigger_creator.should_skip_buy_for_yesterday_gain('BTC-USDT'))
        self.assertEqual(trigger_creator.market_api.calls[0]['limit'], '2')

        trigger_creator.data_cache = {}
        trigger_creator.market_api = _MarketAPI([
            ['today', '100', '100', '100', '100'],
            ['yesterday', '100', '110', '99', '110'],
        ])
        self.assertFalse(trigger_creator.should_skip_buy_for_yesterday_gain('BTC-USDT'))

    def test_yesterday_gain_filter_blocks_all_buy_order_entrypoints(self):
        trigger_creator = OKXAlgoTrigger.__new__(OKXAlgoTrigger)
        trigger_creator.trade_api = object()
        trigger_creator.should_skip_buy_for_yesterday_gain = lambda _inst_id: True

        self.assertFalse(
            trigger_creator._place_limit_buy_order.__wrapped__(
                trigger_creator, 'BTC-USDT', '90'
            )
        )
        self.assertFalse(
            trigger_creator._create_trigger_order_internal.__wrapped__(
                trigger_creator, 'BTC-USDT', '90'
            )
        )

        trigger_creator.get_crypto_data = lambda _inst_id: self.fail('must not fetch today open')
        result = trigger_creator._process_single_limit_pair(
            'BTC-USDT', {'best_limit': '90'}, set()
        )
        self.assertEqual(result, ('BTC-USDT', 'Skipped due to yesterday gain above 10%', False))


if __name__ == '__main__':
    unittest.main()
