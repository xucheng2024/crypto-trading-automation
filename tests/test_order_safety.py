import logging
import unittest
from unittest.mock import patch

from auto_sell_orders import AutoSellOrders
from cancel_pending_limits import OKXLimitOrderManager
from cancel_pending_triggers import OKXOrderManager
from fetch_filled_orders import OKXFilledOrdersFetcher
from okx_client import OKXClient, get_order_operation_error
from monitor_delist import OKXDelistMonitor
from protection_manager import ProtectionManager


class _TradeAPI:
    def __init__(self, place_result, order_result=None):
        self.place_result = place_result
        self.order_result = order_result
        self.last_get_order_kwargs = None

    def place_order(self, **_kwargs):
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


if __name__ == '__main__':
    unittest.main()
