import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectReachableIpv4 } from '../application/tailnet-info.js'
import type { NetworkInterfaceInfo } from 'node:os'

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` })

test('过滤 docker 桥与虚拟化 host-only 网卡，保留物理网卡与 overlay VPN', () => {
  const ips = selectReachableIpv4({
    'enp2s0-ovs': [v4('192.168.3.22')],
    docker0: [v4('172.17.0.1')],
    'br-e7ddd1901e9d': [v4('192.168.128.1')],
    'br-d312c8fd7d53': [v4('172.21.0.1')],
    vmnet8: [v4('192.168.160.1')],
    vboxnet0: [v4('192.168.56.1')],
    virbr0: [v4('192.168.122.1')],
    'vEthernet (Default Switch)': [v4('172.31.240.1')],
    utun3: [v4('198.18.0.1')],
    tun0: [v4('10.8.0.1')],
    tailscale0: [v4('100.125.233.50')],
    zt0: [v4('172.30.1.5')],
    br0: [v4('192.168.1.1')],
  })
  assert.deepEqual(new Set(ips), new Set(['192.168.3.22', '100.125.233.50', '172.30.1.5', '192.168.1.1']))
})

test('环回、链路本地与 IPv6 一律排除，结果去重', () => {
  const ips = selectReachableIpv4({
    lo: [v4('127.0.0.1', true)],
    eno1: [v4('192.168.3.22'), { ...v4('fe80::1'), family: 'IPv6' } as unknown as NetworkInterfaceInfo, v4('169.254.100.7')],
    eno2: [v4('192.168.3.22')],
  })
  assert.deepEqual(ips, ['192.168.3.22'])
})
